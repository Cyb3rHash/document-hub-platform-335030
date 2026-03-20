const { createClient } = require('@supabase/supabase-js');

/**
 * Resolve an environment variable from a prioritized list of names.
 *
 * We support common Supabase env var aliases because different hosting providers / templates
 * sometimes use different names (e.g. NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY, etc.).
 *
 * Contract:
 * - Inputs: array of env var names (strings)
 * - Output: first non-empty string value, else null
 * - Errors: none
 * - Side effects: none
 */
function resolveEnv(names) {
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return null;
}

/**
 * Resolve Supabase URL from supported env var names.
 */
function getSupabaseUrl() {
  return resolveEnv([
    'SUPABASE_URL',
    // Common frontend-style variables sometimes mistakenly provided to backend:
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXTJS_PUBLIC_SUPABASE_URL',
  ]);
}

/**
 * Resolve Supabase Service Role key from supported env var names.
 *
 * IMPORTANT: This is a server-side secret. Never expose to frontend.
 */
function getSupabaseServiceRoleKey() {
  return resolveEnv([
    'SUPABASE_SERVICE_ROLE_KEY',
    // Common aliases used in templates/providers:
    'SUPABASE_SERVICE_KEY',
    'SUPABASE_SERVICE_ROLE',
    'SUPABASE_SECRET_KEY',
  ]);
}

/**
 * Resolve Supabase anon/public key from supported env var names.
 */
function getSupabaseAnonKey() {
  return resolveEnv([
    'SUPABASE_ANON_KEY',
    'SUPABASE_ANON_PUBLIC_KEY',
    // Sometimes only NEXT_PUBLIC_ is configured even for backend:
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'NEXTJS_PUBLIC_SUPABASE_ANON_KEY',
  ]);
}

/**
 * getSupabaseAdmin()
 *
 * Contract:
 * - Inputs: reads env for Supabase URL + service role key (supports aliases)
 * - Output: Supabase client authenticated with Service Role key
 * - Errors: throws if env vars are missing
 * - Side effects: none
 */
function getSupabaseAdmin() {
  const url = getSupabaseUrl();
  const serviceRoleKey = getSupabaseServiceRoleKey();

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase env missing: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY). Please set backend .env.'
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

module.exports = {
  getSupabaseAdmin,
  getSupabaseUrl,
  getSupabaseAnonKey,
  getSupabaseServiceRoleKey,
};
