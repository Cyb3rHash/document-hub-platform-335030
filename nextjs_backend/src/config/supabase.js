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
 * Resolve which env var name (from a prioritized list) is currently providing a value.
 *
 * This is used for safe runtime diagnostics: it returns only the variable *name*,
 * not the value (so secrets are never logged).
 *
 * Contract:
 * - Inputs: array of env var names (strings)
 * - Output: first name that is set/non-empty, else null
 * - Errors: none
 * - Side effects: none
 */
function resolveEnvName(names) {
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return name;
    }
  }
  return null;
}

const SUPABASE_URL_ENV_NAMES = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXTJS_PUBLIC_SUPABASE_URL'];

const SUPABASE_SERVICE_ROLE_KEY_ENV_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SERVICE_ROLE',
  'SUPABASE_SECRET_KEY',
];

const SUPABASE_ANON_KEY_ENV_NAMES = [
  'SUPABASE_ANON_KEY',
  'SUPABASE_ANON_PUBLIC_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXTJS_PUBLIC_SUPABASE_ANON_KEY',
];

/**
 * Resolve Supabase URL from supported env var names.
 */
function getSupabaseUrl() {
  return resolveEnv(SUPABASE_URL_ENV_NAMES);
}

/**
 * Resolve Supabase Service Role key from supported env var names.
 *
 * IMPORTANT: This is a server-side secret. Never expose to frontend.
 */
function getSupabaseServiceRoleKey() {
  return resolveEnv(SUPABASE_SERVICE_ROLE_KEY_ENV_NAMES);
}

/**
 * Resolve Supabase anon/public key from supported env var names.
 */
function getSupabaseAnonKey() {
  return resolveEnv(SUPABASE_ANON_KEY_ENV_NAMES);
}

/**
 * Provide safe, non-secret diagnostics for Supabase environment resolution.
 *
 * Use this when debugging "env missing" issues in deployed environments.
 *
 * Contract:
 * - Inputs: none (reads process.env)
 * - Output: object describing whether required vars are present and which alias is being used
 * - Errors: none
 * - Side effects: none
 */
// PUBLIC_INTERFACE
function getSupabaseEnvDiagnostics() {
  const url = getSupabaseUrl();
  const urlFrom = resolveEnvName(SUPABASE_URL_ENV_NAMES);

  const serviceRoleKeyFrom = resolveEnvName(SUPABASE_SERVICE_ROLE_KEY_ENV_NAMES);
  const anonKeyFrom = resolveEnvName(SUPABASE_ANON_KEY_ENV_NAMES);

  let urlIsValid = false;
  try {
    if (url) {
      // Basic sanity check: must parse as URL. (Does not contact the network.)
      // eslint-disable-next-line no-new
      new URL(url);
      urlIsValid = true;
    }
  } catch (e) {
    urlIsValid = false;
  }

  return {
    hasUrl: Boolean(urlFrom),
    urlFrom,
    urlIsValid,
    hasServiceRoleKey: Boolean(serviceRoleKeyFrom),
    serviceRoleKeyFrom,
    hasAnonKey: Boolean(anonKeyFrom),
    anonKeyFrom,
  };
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
  getSupabaseEnvDiagnostics,
};
