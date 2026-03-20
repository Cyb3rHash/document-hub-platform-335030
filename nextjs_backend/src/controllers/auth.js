const { getURL } = require('../utils/getURL');
const { created, ok, fail, supabaseFail } = require('../utils/http');
const { createClient } = require('@supabase/supabase-js');
const { getSupabaseUrl, getSupabaseAnonKey } = require('../config/supabase');

/**
 * Creates a Supabase anon client (used for auth flows like signUp/signInWithPassword).
 */
function getSupabaseAnon() {
  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();

  if (!url || !anonKey) {
    throw new Error(
      'Supabase env missing: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and/or SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY). Please set backend .env.'
    );
  }

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

class AuthController {
  /**
   * Register a user via Supabase email/password.
   *
   * Returns access_token so the frontend can call authenticated endpoints.
   */
  // PUBLIC_INTERFACE
  async signup(req, res, next) {
    try {
      const { email, password, full_name } = req.body || {};
      if (!email || !password) {
        return fail(res, 400, 'VALIDATION_ERROR', 'email and password are required.');
      }

      const supabaseAnon = getSupabaseAnon();
      const redirectTo = `${getURL()}auth/callback`;

      const { data, error } = await supabaseAnon.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo },
      });

      if (error) {
        return supabaseFail(res, 400, 'SIGNUP_FAILED', 'Signup failed.', error);
      }

      // Ensure profile row exists; service role bypasses RLS.
      if (data?.user?.id) {
        const { error: profileError } = await req.supabaseAdmin
          .from('profiles')
          .upsert(
            {
              id: data.user.id,
              email: data.user.email,
              full_name: full_name || null,
            },
            { onConflict: 'id' }
          );

        if (profileError) {
          return supabaseFail(
            res,
            500,
            'PROFILE_CREATE_FAILED',
            'Signup succeeded but profile creation failed.',
            profileError
          );
        }
      }

      return created(res, {
        user: data.user,
        session: data.session, // may be null if email confirmation required
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Login a user via Supabase email/password.
   *
   * Returns access_token/refresh_token in the session.
   */
  // PUBLIC_INTERFACE
  async login(req, res, next) {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return fail(res, 400, 'VALIDATION_ERROR', 'email and password are required.');
      }

      const supabaseAnon = getSupabaseAnon();
      const { data, error } = await supabaseAnon.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return supabaseFail(res, 401, 'LOGIN_FAILED', 'Login failed.', error);
      }

      return ok(res, {
        user: data.user,
        session: data.session,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Return the current authenticated user's profile.
   */
  // PUBLIC_INTERFACE
  async me(req, res, next) {
    try {
      if (!req.auth?.userId) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }

      const { data, error } = await req.supabaseAdmin
        .from('profiles')
        .select('id,email,full_name,avatar_url,role,created_at,updated_at')
        .eq('id', req.auth.userId)
        .maybeSingle();

      if (error) {
        return supabaseFail(res, 500, 'PROFILE_LOOKUP_FAILED', 'Failed to load profile.', error);
      }

      return ok(res, { profile: data });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AuthController();

