/**
 * Create a standardized success response.
 */
// PUBLIC_INTERFACE
function ok(res, data, meta) {
  return res.status(200).json({
    status: 'ok',
    data,
    ...(meta ? { meta } : {}),
  });
}

/**
 * Create a standardized created response.
 */
// PUBLIC_INTERFACE
function created(res, data) {
  return res.status(201).json({
    status: 'ok',
    data,
  });
}

/**
 * Standard error response helper.
 */
// PUBLIC_INTERFACE
function fail(res, httpStatus, code, message, details) {
  return res.status(httpStatus).json({
    status: 'error',
    code,
    message,
    ...(details ? { details } : {}),
  });
}

/**
 * Maps Supabase error objects into safe API errors.
 */
// PUBLIC_INTERFACE
function supabaseFail(res, httpStatus, code, message, supabaseError) {
  return fail(res, httpStatus, code, message, supabaseError?.message);
}

module.exports = { ok, created, fail, supabaseFail };

