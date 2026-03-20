const { createClient } = require('@supabase/supabase-js');
const { getSupabaseAdmin } = require('../config/supabase');

/**
 * Extract a bearer token from incoming request headers.
 *
 * Supported sources (in order):
 * - Authorization: Bearer <jwt>
 * - authorization-token: Bearer <jwt> (seen in some proxies)
 * - x-supabase-auth: Bearer <jwt> (non-standard, but sometimes used)
 *
 * Contract:
 * - Inputs: Express req.headers
 * - Output: { token: string|null, source: string|null }
 * - Errors: none (never throws)
 * - Side effects: none
 */
function extractBearerTokenFromHeaders(headers) {
  const candidates = [
    { key: 'authorization', value: headers?.authorization },
    { key: 'authorization-token', value: headers?.['authorization-token'] },
    { key: 'x-supabase-auth', value: headers?.['x-supabase-auth'] },
  ];

  for (const c of candidates) {
    if (!c.value) continue;
    const raw = Array.isArray(c.value) ? c.value[0] : String(c.value);
    const match = raw.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return { token: match[1], source: c.key };
    }
  }

  return { token: null, source: null };
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
  /**
   * AttachSupabaseAndAuthFlow
   *
   * Purpose:
   * - Attach request-scoped supabase clients and auth context derived from a Bearer token.
   *
   * Contract:
   * - Inputs: Express (req,res,next)
   * - Outputs:
   *   - req.auth = { token, userId, role, tokenSource, error? }
   *   - req.supabaseAdmin: service-role supabase client OR null when env missing
   *   - req.supabase: user-scoped supabase client OR null
   *   - response headers may include x-auth-debug when auth cannot be evaluated
   * - Errors: never throws to caller; forwards unexpected errors to express error handler
   * - Side effects: calls Supabase Auth getUser(token) when possible
   *
   * Observability:
   * - x-auth-debug: machine-readable reason when request is unauthenticated due to config/token issues
   */
  try {
    const { token, source } = extractBearerTokenFromHeaders(req.headers);

    // Default request auth context (always present).
    req.auth = {
      token,
      tokenSource: source,
      userId: null,
      role: 'anon',
      error: null,
    };

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
      if (token) {
        req.auth.error = 'SUPABASE_ADMIN_ENV_MISSING';
        res.setHeader('x-auth-debug', 'supabase_admin_env_missing');
      }
      return next();
    }

    if (!token) return next();

    // Verify token via admin (service role). This avoids trusting unverified JWT claims.
    const { data, error } = await req.supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      req.auth.error = 'INVALID_OR_EXPIRED_TOKEN';
      res.setHeader('x-auth-debug', 'invalid_or_expired_token');
      // Keep request unauthenticated but do not hard-fail; route handlers can requireAuth.
      return next();
    }

    req.auth.userId = data.user.id;
    req.auth.role = 'authenticated';

    // A user-scoped client additionally requires SUPABASE_ANON_KEY; if it's missing,
    // keep request authenticated but skip attaching req.supabase so controllers can
    // return a clearer error for RLS-reliant operations.
    try {
      req.supabase = getSupabaseUserClient(token);
    } catch (e) {
      req.supabase = null;
      res.setHeader('x-auth-debug', 'supabase_anon_env_missing_for_rls_client');
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
    // Provide debuggable, non-sensitive context. This is crucial for cases where
    // the client DID send a Bearer token but the backend could not validate it
    // due to missing Supabase env or an expired token.
    const details = req.auth?.error
      ? { reason: req.auth.error, tokenSource: req.auth.tokenSource || null }
      : { reason: 'MISSING_BEARER_TOKEN', tokenSource: req.auth?.tokenSource || null };

    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Authentication required.',
      details,
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
