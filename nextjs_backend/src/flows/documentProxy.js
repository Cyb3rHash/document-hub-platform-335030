const { fail, supabaseFail } = require('../utils/http');

/**
 * Minimal mime -> file extension map for safe fallback filenames.
 * (We avoid introducing heavy dependencies just for this.)
 */
const MIME_TO_EXT = new Map([
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
]);

function normalizeInlineFilename({ originalFilename, title, mimeType }) {
  const rawBase = (originalFilename || title || 'document').toString().trim() || 'document';
  const safeBase = rawBase.replace(/[^\w.\-()+ ]/g, '_').slice(0, 160);

  // If it already has an extension, keep it.
  if (safeBase.includes('.') && !safeBase.endsWith('.')) return safeBase;

  const ext = MIME_TO_EXT.get(String(mimeType || '').toLowerCase());
  return ext ? `${safeBase}.${ext}` : safeBase;
}

/**
 * DocumentInlinePreviewProxyFlow
 *
 * Flow name: DocumentInlinePreviewProxyFlow
 * Entrypoint: streamDocumentInlinePreviewFlow()
 *
 * Purpose:
 * - Provide a SAME-ORIGIN preview URL that browsers can embed reliably (iframe/PDF.js)
 *   even when Supabase signed URLs are blocked cross-site by privacy settings.
 *
 * Contract:
 * - Inputs:
 *   - deps.fetchImpl: function(url, init) -> fetch Response (required)
 *   - deps.supabaseAdmin: Supabase admin client (required)
 *   - deps.supabaseUser?: Supabase RLS client (optional; for permission check)
 *   - input: {
 *       documentId: string (required),
 *       expiresInSeconds?: number (optional; default 900; max 3600),
 *       authUserId?: string|null (optional; indicates authenticated caller),
 *     }
 * - Outputs:
 *   - { ok: true, meta: { filename, mimeType, size?, cacheSeconds }, signedUrl, upstreamResponse }
 * - Errors:
 *   - Throws objects { httpStatus, code, message, details? } for boundary to map to API.
 * - Side effects:
 *   - Calls Supabase Postgres to validate access (RLS when possible).
 *   - Calls Supabase Storage to create signed URL.
 *   - Calls upstream fetch to stream bytes.
 *
 * Invariants:
 * - Never returns private doc bytes to anonymous users.
 * - Uses RLS client for authenticated users when available (avoids leaking existence).
 */
async function streamDocumentInlinePreviewFlow({ deps, input }) {
  const { fetchImpl, supabaseAdmin, supabaseUser } = deps || {};
  const { documentId, expiresInSeconds, authUserId } = input || {};

  if (!documentId) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'documentId is required.' };
  }
  if (!supabaseAdmin) {
    throw {
      httpStatus: 503,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: 'Supabase is not configured on the backend.',
    };
  }
  if (!fetchImpl) {
    throw { httpStatus: 500, code: 'INTERNAL_ERROR', message: 'fetch implementation not provided.' };
  }

  const requestedExpires = expiresInSeconds ? parseInt(String(expiresInSeconds), 10) : 900;
  const expires = Math.min(Math.max(Number.isFinite(requestedExpires) ? requestedExpires : 900, 60), 3600);

  // Step 1: Load doc metadata with appropriate permission semantics.
  // - Authenticated + RLS client: use it to enforce permissions (owner/admin/grants).
  // - Anonymous: only allow public/unlisted using admin client with explicit restriction.
  let doc = null;

  if (authUserId && supabaseUser) {
    const { data, error } = await supabaseUser
      .from('documents')
      .select('id,title,mime_type,original_filename,storage_bucket,storage_path,visibility,disable_download')
      .eq('id', documentId)
      .maybeSingle();

    if (error) {
      // Avoid leaking existence under RLS: normalize to 404.
      throw { httpStatus: 404, code: 'NOT_FOUND', message: 'Document not found.' };
    }
    if (!data) {
      throw { httpStatus: 404, code: 'NOT_FOUND', message: 'Document not found.' };
    }
    doc = data;
  } else {
    const { data, error } = await supabaseAdmin
      .from('documents')
      .select('id,title,mime_type,original_filename,storage_bucket,storage_path,visibility,disable_download')
      .eq('id', documentId)
      .in('visibility', ['public', 'unlisted'])
      .maybeSingle();

    if (error) {
      throw { httpStatus: 500, code: 'DOCUMENT_GET_FAILED', message: 'Failed to load document.', details: error.message };
    }
    if (!data) {
      throw { httpStatus: 404, code: 'NOT_FOUND', message: 'Document not found.' };
    }
    doc = data;
  }

  const bucket = doc.storage_bucket || 'documents';
  const filePath = doc.storage_path;

  // Step 2: Create short-lived signed URL (we keep this server-side; client never sees it).
  const { data: signed, error: signErr } = await supabaseAdmin.storage.from(bucket).createSignedUrl(filePath, expires);
  if (signErr || !signed?.signedUrl) {
    throw {
      httpStatus: 500,
      code: 'SIGNED_URL_FAILED',
      message: 'Failed to create signed URL for preview.',
      details: signErr?.message || 'Unknown signing error.',
    };
  }

  // Step 3: Fetch upstream bytes (server-side) and return response for streaming.
  const upstreamResponse = await fetchImpl(signed.signedUrl, {
    method: 'GET',
    // No credentials needed; signed URL authorizes the request.
    redirect: 'follow',
  });

  if (!upstreamResponse.ok) {
    throw {
      httpStatus: 502,
      code: 'UPSTREAM_FETCH_FAILED',
      message: `Upstream storage returned HTTP ${upstreamResponse.status}.`,
      details: await safeReadUpstreamText(upstreamResponse),
    };
  }

  const mimeType =
    upstreamResponse.headers.get('content-type') ||
    (doc.mime_type ? String(doc.mime_type) : 'application/octet-stream');

  const filename = normalizeInlineFilename({
    originalFilename: doc.original_filename,
    title: doc.title,
    mimeType,
  });

  return {
    ok: true,
    signedUrl: signed.signedUrl,
    upstreamResponse,
    meta: {
      filename,
      mimeType,
      cacheSeconds: Math.min(60, Math.floor(expires / 3)), // small cache; signed urls are short-lived
    },
  };
}

async function safeReadUpstreamText(res) {
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json') || ct.includes('text/')) return await res.text();
    return null;
  } catch {
    return null;
  }
}

/**
 * DocumentInlinePreviewProxyHttpBoundary
 *
 * Maps flow errors into standardized HTTP responses and sets safe headers for inline preview streaming.
 *
 * Contract:
 * - Inputs: Express req/res, and a function `runFlow` that returns flow result.
 * - Output: Streams bytes to client with inline content disposition.
 */
async function documentInlinePreviewProxyHttpBoundary({ req, res, runFlow }) {
  const startedAt = Date.now();
  const documentId = req.params.id;
  const expiresIn = req.query.expiresIn;

  // Minimal, structured logs for long-term debugging.
  console.info('[DocumentInlinePreviewProxy]', {
    step: 'start',
    documentId,
    auth: Boolean(req.auth?.userId),
    expiresIn,
  });

  try {
    const result = await runFlow();

    // Ensure this endpoint is embeddable same-origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Force inline preview rather than attachment download.
    res.setHeader('Content-Type', result.meta.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${result.meta.filename}"`);

    // Avoid caching across users. (CDNs may still cache if told to; keep private.)
    res.setHeader('Cache-Control', `private, max-age=${result.meta.cacheSeconds}`);

    // Stream upstream headers that are safe/helpful (range requests can help PDF viewers).
    const acceptRanges = result.upstreamResponse.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

    const contentLength = result.upstreamResponse.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Node 18 fetch Response.body is a web ReadableStream. Convert to Node stream.
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb(result.upstreamResponse.body);

    nodeStream.on('error', (e) => {
      console.error('[DocumentInlinePreviewProxy]', { step: 'stream_error', documentId, message: e?.message });
      // If headers already sent, just end.
      try {
        res.end();
      } catch {
        // ignore
      }
    });

    nodeStream.pipe(res);

    res.on('finish', () => {
      console.info('[DocumentInlinePreviewProxy]', {
        step: 'finish',
        documentId,
        status: res.statusCode,
        elapsedMs: Date.now() - startedAt,
      });
    });
  } catch (err) {
    console.error('[DocumentInlinePreviewProxy]', {
      step: 'error',
      documentId,
      message: err?.message || String(err),
      code: err?.code,
      httpStatus: err?.httpStatus,
      details: err?.details,
    });

    if (err && err.httpStatus) {
      return fail(res, err.httpStatus, err.code, err.message, err.details);
    }
    return fail(res, 500, 'INTERNAL_ERROR', 'Internal Server Error');
  }
}

module.exports = {
  streamDocumentInlinePreviewFlow,
  documentInlinePreviewProxyHttpBoundary,
};
