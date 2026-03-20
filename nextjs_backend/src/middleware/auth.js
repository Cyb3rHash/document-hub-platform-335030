const { createClient } = require('@supabase/supabase-js');
const { getSupabaseAdmin } = require('../config/supabase');

/**
 * Extracts a bearer token from an Authorization header.
 *
 * @param {string | undefined} header Authorization header value
 * @returns {string | null} token or null
 */
function extractBearerToken(header) {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Build a Supabase client scoped to a user's JWT for RLS-enforced operations.
 *
 * Contract:
 * - Inputs: jwt string, reads env SUPABASE_URL, SUPABASE_ANON_KEY
 * - Output: Supabase client using anon key + Authorization header(jwt)
 * - Errors: throws if env missing
 * - Side effects: none
 *
 * Note: For RLS to apply, requests should use the anon key and the user's JWT.
 */
function getSupabaseUserClient(jwt) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase env missing: SUPABASE_URL and/or SUPABASE_ANON_KEY. Please set backend .env.'
    );
  }

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
  });
}

/**
 * Adds request-scoped Supabase clients:
 * - req.supabaseAdmin: service-role client (privileged)
 * - req.supabase: user-scoped RLS client if Authorization bearer token present, else null
 * - req.auth: { token, userId, role } derived from token (verified via admin auth.getUser)
 *
 * This middleware does NOT enforce authentication; it only parses/attaches context.
 */
// PUBLIC_INTERFACE
async function attachSupabaseAndAuth(req, res, next) {
  try {
    // Default request auth context (always present).
    const token = extractBearerToken(req.headers.authorization);
    req.auth = { token, userId: null, role: 'anon' };

    // Default supabase clients to null; controllers can decide how to behave.
    req.supabaseAdmin = null;
    req.supabase = null;
    req.supabaseEnvMissing = false;

    // Supabase env may be missing in some deployments (e.g. local CI, first-run).
    // This middleware is intentionally non-enforcing; missing env should not crash
    // the entire API surface with 500s.
    try {
      req.supabaseAdmin = getSupabaseAdmin();
    } catch (e) {
      req.supabaseEnvMissing = true;
      return next();
    }

    if (!token) return next();

    // Verify token via admin (service role). This avoids trusting unverified JWT claims.
    const { data, error } = await req.supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      // Keep request unauthenticated but do not hard-fail; route handlers can requireAuth.
      return next();
    }

    req.auth.userId = data.user.id;
    req.auth.role = 'authenticated';

    // A user-scoped client additionally requires SUPABASE_ANON_KEY; if it's missing,
    // keep request authenticated but skip attaching req.supabase so controllers can
    // fall back to admin or return a clearer error.
    try {
      req.supabase = getSupabaseUserClient(token);
    } catch (e) {
      req.supabase = null;
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Middleware that requires a valid authenticated user.
 */
// PUBLIC_INTERFACE
function requireAuth(req, res, next) {
  if (!req.auth?.userId) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Authentication required (missing/invalid bearer token).',
    });
  }
  return next();
}

/**
 * Middleware that requires the caller to be an admin user.
 *
 * Implementation notes:
 * - Uses service role to fetch profile role from public.profiles.
 * - This is explicit and debuggable; avoids relying on JWT custom claims.
 */
// PUBLIC_INTERFACE
async function requireAdmin(req, res, next) {
  if (!req.auth?.userId) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Authentication required (missing/invalid bearer token).',
    });
  }

  try {
    const { data, error } = await req.supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', req.auth.userId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        status: 'error',
        code: 'PROFILE_LOOKUP_FAILED',
        message: 'Failed to look up profile role.',
        details: error.message,
      });
    }

    if (data?.role !== 'admin') {
      return res.status(403).json({
        status: 'error',
        code: 'FORBIDDEN',
        message: 'Admin privileges required.',
      });
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  attachSupabaseAndAuth,
  requireAuth,
  requireAdmin,
};

