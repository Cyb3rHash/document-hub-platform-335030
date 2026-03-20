const { createClient } = require('@supabase/supabase-js');

/**
 * getSupabaseAdmin()
 *
 * Contract:
 * - Inputs: reads env SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - Output: Supabase client authenticated with Service Role key
 * - Errors: throws if env vars are missing
 * - Side effects: none
 */
function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase env missing: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY. Please set backend .env.'
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

module.exports = { getSupabaseAdmin };
