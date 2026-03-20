const path = require('path');
const { ok, created, fail, supabaseFail } = require('../utils/http');

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'text/plain',
]);

function sanitizeFilename(filename) {
  const base = path.basename(filename || 'file');
  return base.replace(/[^\w.\-()+ ]/g, '_');
}

function normalizeSort(sort) {
  // allowed: created_at, view_count, title
  const allowed = new Set(['created_at', 'view_count', 'title']);
  if (!sort) return { column: 'created_at', ascending: false };

  const parts = String(sort).split(':');
  const column = allowed.has(parts[0]) ? parts[0] : 'created_at';
  const dir = (parts[1] || 'desc').toLowerCase();
  return { column, ascending: dir === 'asc' };
}

/**
 * UploadDocumentFlow
 *
 * Single canonical flow for: create document metadata + upload storage object + update row.
 *
 * Contract:
 * - Inputs: { ownerId, title, description?, visibility, file{buffer,mimetype,originalname,size}, disable_download?, watermark_text? }
 * - Outputs: { document } (documents row)
 * - Errors:
 *   - validation errors -> thrown as {httpStatus, code, message}
 *   - supabase errors -> thrown with context
 * - Side effects:
 *   - creates/updates rows in public.documents
 *   - uploads a file to Storage bucket 'documents'
 */
async function uploadDocumentFlow({ supabaseAdmin, input }) {
  const {
    ownerId,
    title,
    description,
    visibility,
    disable_download,
    watermark_text,
    file,
  } = input;

  if (!ownerId) {
    throw { httpStatus: 401, code: 'UNAUTHORIZED', message: 'Authentication required.' };
  }
  if (!title) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'title is required.' };
  }
  if (!file) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'file is required.' };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw {
      httpStatus: 400,
      code: 'FILE_TOO_LARGE',
      message: `file too large (max ${MAX_FILE_SIZE_BYTES} bytes).`,
    };
  }
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw {
      httpStatus: 400,
      code: 'UNSUPPORTED_FILE_TYPE',
      message: `unsupported mime type: ${file.mimetype}`,
    };
  }

  const safeName = sanitizeFilename(file.originalname);
  const ext = path.extname(safeName) || '';
  const bucket = 'documents';

  // Step 1: create doc row with placeholder storage path (we know id after insert)
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('documents')
    .insert({
      owner_id: ownerId,
      title,
      description: description || null,
      visibility: visibility || 'private',
      mime_type: file.mimetype,
      original_filename: safeName,
      file_size_bytes: file.size,
      storage_bucket: bucket,
      storage_path: 'pending',
      disable_download: Boolean(disable_download),
      watermark_text: watermark_text || null,
      status: 'uploaded',
    })
    .select('*')
    .single();

  if (insertError) {
    throw {
      httpStatus: 400,
      code: 'DOCUMENT_CREATE_FAILED',
      message: 'Failed to create document row.',
      details: insertError.message,
    };
  }

  const docId = inserted.id;
  const storagePath = `${ownerId}/${docId}/original${ext}`;

  // Step 2: upload bytes to storage
  const { error: uploadError } = await supabaseAdmin.storage
    .from(bucket)
    .upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (uploadError) {
    // Attempt to delete doc row to avoid orphan metadata
    await supabaseAdmin.from('documents').delete().eq('id', docId);
    throw {
      httpStatus: 500,
      code: 'STORAGE_UPLOAD_FAILED',
      message: 'Failed to upload file to storage.',
      details: uploadError.message,
    };
  }

  // Step 3: update doc row with actual path
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('documents')
    .update({ storage_path: storagePath })
    .eq('id', docId)
    .select('*')
    .single();

  if (updateError) {
    throw {
      httpStatus: 500,
      code: 'DOCUMENT_UPDATE_FAILED',
      message: 'File uploaded but failed to update document metadata.',
      details: updateError.message,
    };
  }

  return { document: updated };
}

class DocumentsController {
  /**
   * Create and upload a document.
   *
   * Expects multipart/form-data with:
   * - file: binary
   * - title: string
   * - description?: string
   * - visibility?: private|public|unlisted
   * - disable_download?: boolean-like
   * - watermark_text?: string
   */
  // PUBLIC_INTERFACE
  async upload(req, res, next) {
    try {
      if (!req.auth?.userId) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const file = req.file;
      const { title, description, visibility, disable_download, watermark_text } = req.body || {};

      const result = await uploadDocumentFlow({
        supabaseAdmin: req.supabaseAdmin,
        input: {
          ownerId: req.auth.userId,
          title,
          description,
          visibility,
          disable_download: disable_download === 'true' || disable_download === true,
          watermark_text,
          file,
        },
      });

      return created(res, result);
    } catch (err) {
      if (err && err.httpStatus) {
        return fail(res, err.httpStatus, err.code, err.message, err.details);
      }
      return next(err);
    }
  }

  /**
   * List/search documents visible to the caller.
   *
   * Query params:
   * - q?: text (ILIKE title/description)
   * - visibility?: public|unlisted|private (optional filter)
   * - owner?: me|<uuid> (admin only for other uuid)
   * - sort?: created_at:desc|created_at:asc|view_count:desc|title:asc ...
   * - limit?: number (default 20, max 100)
   * - offset?: number (default 0)
   */
  // PUBLIC_INTERFACE
  async list(req, res, next) {
    try {
      const q = (req.query.q || '').toString().trim();
      const visibility = req.query.visibility ? String(req.query.visibility) : null;
      const owner = req.query.owner ? String(req.query.owner) : null;
      const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 100);
      const offset = parseInt(req.query.offset || '0', 10) || 0;
      const { column: sortColumn, ascending } = normalizeSort(req.query.sort);

      // Use RLS client when authenticated, otherwise anon cannot be used here (we only have admin + optionally req.supabase).
      // For public listing, we'll still use admin but we must enforce visibility=public/unlisted when unauthenticated.
      // This keeps behavior consistent even if storage policies differ.
      const isAuthed = Boolean(req.auth?.userId);
      const isAdmin = await this._isAdminCached(req);

      let query = req.supabaseAdmin
        .from('documents')
        .select(
          'id,owner_id,title,description,visibility,mime_type,original_filename,file_size_bytes,storage_bucket,storage_path,preview_storage_path,status,disable_download,watermark_text,view_count,created_at,updated_at',
          { count: 'exact' }
        );

      if (!isAuthed) {
        query = query.in('visibility', ['public', 'unlisted']);
      }

      if (visibility) {
        query = query.eq('visibility', visibility);
      }

      if (owner) {
        if (owner === 'me') {
          if (!req.auth?.userId) {
            return fail(res, 401, 'UNAUTHORIZED', 'Authentication required for owner=me.');
          }
          query = query.eq('owner_id', req.auth.userId);
        } else {
          if (!isAdmin) {
            return fail(res, 403, 'FORBIDDEN', 'Admin required to filter by arbitrary owner.');
          }
          query = query.eq('owner_id', owner);
        }
      }

      if (q) {
        // Basic search (can be upgraded to full-text later)
        query = query.or(`title.ilike.%${q}%,description.ilike.%${q}%`);
      }

      query = query.order(sortColumn, { ascending }).range(offset, offset + limit - 1);

      const { data, error, count } = await query;
      if (error) {
        return supabaseFail(res, 500, 'DOCUMENT_LIST_FAILED', 'Failed to list documents.', error);
      }

      return ok(res, { items: data }, { count, limit, offset });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Get a single document metadata.
   */
  // PUBLIC_INTERFACE
  async get(req, res, next) {
    try {
      const id = req.params.id;
      if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'id is required.');

      // Use RLS-aware approach: if authenticated, try user client for consistent permission behavior.
      // If not authenticated, enforce public/unlisted.
      if (req.auth?.userId && req.supabase) {
        const { data, error } = await req.supabase.from('documents').select('*').eq('id', id).single();
        if (error) {
          // If RLS denies, it will typically show as empty or error. Normalize:
          return supabaseFail(res, 404, 'NOT_FOUND', 'Document not found.', error);
        }
        return ok(res, { document: data });
      }

      const { data, error } = await req.supabaseAdmin
        .from('documents')
        .select('*')
        .eq('id', id)
        .in('visibility', ['public', 'unlisted'])
        .maybeSingle();

      if (error) return supabaseFail(res, 500, 'DOCUMENT_GET_FAILED', 'Failed to load document.', error);
      if (!data) return fail(res, 404, 'NOT_FOUND', 'Document not found.');

      return ok(res, { document: data });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Increment view count by inserting a document_views row.
   *
   * This relies on DB trigger to increment documents.view_count.
   * For privacy, we only store viewer_ip/user_agent; viewer_id is set for authenticated.
   */
  // PUBLIC_INTERFACE
  async recordView(req, res, next) {
    try {
      const id = req.params.id;
      if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'id is required.');

      const viewerIp =
        (req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
        req.ip ||
        null;

      const insertPayload = {
        document_id: id,
        viewer_id: req.auth?.userId || null,
        viewer_ip: viewerIp,
        user_agent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 512) : null,
        page_number: req.body?.page_number ?? null,
      };

      // Use user client if available so RLS enforces viewability.
      const client = req.supabase || req.supabaseAdmin;

      const { error } = await client.from('document_views').insert(insertPayload);
      if (error) {
        // If not viewable, RLS will block insert.
        return supabaseFail(res, 403, 'VIEW_NOT_ALLOWED', 'Not allowed to record a view for this document.', error);
      }

      return ok(res, { recorded: true });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Produce a signed URL for a document file.
   *
   * Behavior:
   * - If document is public/unlisted AND you have enabled storage public-read policy, direct public access may work,
   *   but we still return signed URL for consistent behavior.
   * - For private docs, requires auth and view permission via RLS (checked by reading document via user client).
   */
  // PUBLIC_INTERFACE
  async getSignedUrl(req, res, next) {
    try {
      const id = req.params.id;
      const expiresIn = Math.min(parseInt(req.query.expiresIn || '300', 10) || 300, 3600);

      if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'id is required.');

      // Load doc with proper permission semantics.
      let doc = null;

      if (req.auth?.userId && req.supabase) {
        const { data, error } = await req.supabase.from('documents').select('id,storage_bucket,storage_path').eq('id', id).single();
        if (error) return supabaseFail(res, 404, 'NOT_FOUND', 'Document not found.', error);
        doc = data;
      } else {
        // anon: only public/unlisted
        const { data, error } = await req.supabaseAdmin
          .from('documents')
          .select('id,storage_bucket,storage_path,visibility')
          .eq('id', id)
          .in('visibility', ['public', 'unlisted'])
          .maybeSingle();

        if (error) return supabaseFail(res, 500, 'DOCUMENT_GET_FAILED', 'Failed to load document.', error);
        if (!data) return fail(res, 404, 'NOT_FOUND', 'Document not found.');
        doc = data;
      }

      const bucket = doc.storage_bucket || 'documents';
      const filePath = doc.storage_path;

      const { data, error } = await req.supabaseAdmin.storage.from(bucket).createSignedUrl(filePath, expiresIn);
      if (error) {
        return supabaseFail(res, 500, 'SIGNED_URL_FAILED', 'Failed to create signed URL.', error);
      }

      return ok(res, { signedUrl: data.signedUrl, expiresIn });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Cached admin check per-request.
   */
  async _isAdminCached(req) {
    if (req._isAdmin !== undefined) return req._isAdmin;

    if (!req.auth?.userId) {
      req._isAdmin = false;
      return false;
    }

    const { data, error } = await req.supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', req.auth.userId)
      .maybeSingle();

    req._isAdmin = !error && data?.role === 'admin';
    return req._isAdmin;
  }
}

module.exports = new DocumentsController();

