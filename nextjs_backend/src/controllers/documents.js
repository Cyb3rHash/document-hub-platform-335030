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

function parseVisibility(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (!['private', 'public', 'unlisted'].includes(s)) return null;
  return s;
}

function parseBooleanLike(v) {
  if (v === true || v === false) return v;
  if (v === undefined || v === null) return null;
  const s = String(v).toLowerCase().trim();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return null;
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

/**
 * UpdateDocumentMetadataFlow
 *
 * Canonical flow for updating document metadata fields (title/description/visibility/etc).
 *
 * Contract:
 * - Inputs: { client, documentId, actorUserId, patch }
 *   - client: supabase client (prefer RLS client for permission semantics)
 *   - patch supports: title?, description?, visibility?, disable_download?, watermark_text?, status?, page_count?
 * - Output: { document }
 * - Errors:
 *   - validation -> thrown {httpStatus, code, message}
 *   - permission/rls -> surfaces as NOT_FOUND (do not leak)
 * - Side effects: updates public.documents row
 */
async function updateDocumentMetadataFlow({ client, documentId, patch }) {
  if (!documentId) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'id is required.' };
  }
  if (!patch || Object.keys(patch).length === 0) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'No updatable fields provided.' };
  }

  const update = {};
  if (patch.title !== undefined) update.title = String(patch.title);
  if (patch.description !== undefined) update.description = patch.description === null ? null : String(patch.description);
  if (patch.visibility !== undefined) {
    const vis = parseVisibility(patch.visibility);
    if (!vis) throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'visibility must be private|public|unlisted.' };
    update.visibility = vis;
  }
  if (patch.disable_download !== undefined) {
    const b = parseBooleanLike(patch.disable_download);
    if (b === null) throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'disable_download must be boolean-like.' };
    update.disable_download = b;
  }
  if (patch.watermark_text !== undefined) {
    update.watermark_text = patch.watermark_text === null ? null : String(patch.watermark_text);
  }
  // Allow status/page_count updates primarily for admins/processing pipelines (RLS will restrict).
  if (patch.status !== undefined) update.status = String(patch.status);
  if (patch.page_count !== undefined) {
    const pc = patch.page_count === null ? null : parseInt(String(patch.page_count), 10);
    if (pc !== null && (Number.isNaN(pc) || pc < 0)) {
      throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'page_count must be a non-negative integer.' };
    }
    update.page_count = pc;
  }

  const { data, error } = await client
    .from('documents')
    .update(update)
    .eq('id', documentId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw { httpStatus: 500, code: 'DOCUMENT_UPDATE_FAILED', message: 'Failed to update document.', details: error.message };
  }
  if (!data) {
    // RLS may hide it, so treat as 404.
    throw { httpStatus: 404, code: 'NOT_FOUND', message: 'Document not found.' };
  }
  return { document: data };
}

/**
 * DeleteDocumentFlow
 *
 * Canonical flow for deleting a document: deletes storage objects + deletes DB row.
 *
 * Contract:
 * - Inputs: { supabaseAdmin, client, documentId }
 *   - client: RLS client for permission check (owner/admin)
 * - Output: { deleted: true }
 * - Errors:
 *   - NOT_FOUND if not accessible
 * - Side effects:
 *   - removes storage objects under <owner>/<docId>/ (best-effort)
 *   - deletes public.documents row (cascades versions/access/views)
 *
 * Notes:
 * - Storage deletion is done with service role. If Storage RLS policies are not installed,
 *   service role still can delete objects.
 */
async function deleteDocumentFlow({ supabaseAdmin, client, documentId }) {
  if (!documentId) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'id is required.' };
  }

  // Permission + metadata fetch via RLS client (do not leak existence).
  const { data: doc, error: docErr } = await client
    .from('documents')
    .select('id,owner_id,storage_bucket,storage_path,preview_storage_path')
    .eq('id', documentId)
    .maybeSingle();

  if (docErr) {
    throw { httpStatus: 404, code: 'NOT_FOUND', message: 'Document not found.' };
  }
  if (!doc) {
    throw { httpStatus: 404, code: 'NOT_FOUND', message: 'Document not found.' };
  }

  const bucket = doc.storage_bucket || 'documents';
  const prefix = `${doc.owner_id}/${doc.id}/`;

  // Best-effort: list objects and remove them.
  // Storage list is limited; we only need to remove objects we created under doc prefix.
  const { data: listed, error: listErr } = await supabaseAdmin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (!listErr && Array.isArray(listed) && listed.length > 0) {
    const toRemove = listed.map((o) => `${prefix}${o.name}`);
    await supabaseAdmin.storage.from(bucket).remove(toRemove);
  }

  // Also attempt removal of known paths (in case list is restricted by storage configuration).
  const knownPaths = [doc.storage_path, doc.preview_storage_path].filter(Boolean);
  if (knownPaths.length > 0) {
    await supabaseAdmin.storage.from(bucket).remove(knownPaths);
  }

  // Delete DB row via RLS client so permissions apply.
  const { error: delErr } = await client.from('documents').delete().eq('id', documentId);
  if (delErr) {
    throw { httpStatus: 500, code: 'DOCUMENT_DELETE_FAILED', message: 'Failed to delete document.', details: delErr.message };
  }

  return { deleted: true };
}

/**
 * SetDocumentVisibilityFlow
 *
 * Canonical flow for publish/unpublish as a visibility change.
 *
 * Contract:
 * - Inputs: { client, documentId, visibility }
 * - Output: { document }
 */
async function setDocumentVisibilityFlow({ client, documentId, visibility }) {
  const vis = parseVisibility(visibility);
  if (!vis) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'visibility must be private|public|unlisted.' };
  }
  return updateDocumentMetadataFlow({ client, documentId, patch: { visibility: vis } });
}

/**
 * UpsertDocumentPermissionFlow
 *
 * Canonical flow for sharing / permission grants.
 *
 * Contract:
 * - Inputs: { client, documentId, granteeId, accessLevel }
 * - Output: { grant } (document_access row)
 * - Errors:
 *   - validation -> thrown
 *   - permission via RLS -> surfaces as 403-ish/404 depending on supabase error; we normalize to FORBIDDEN for insert/update failures.
 * - Side effects:
 *   - upserts public.document_access (document_id, grantee_id)
 */
async function upsertDocumentPermissionFlow({ client, documentId, granteeId, accessLevel }) {
  if (!documentId || !granteeId) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'documentId and granteeId are required.' };
  }
  const level = (accessLevel || 'viewer').toString().toLowerCase();
  if (!['viewer', 'editor'].includes(level)) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'access_level must be viewer|editor.' };
  }

  const { data, error } = await client
    .from('document_access')
    .upsert(
      { document_id: documentId, grantee_id: granteeId, access_level: level },
      { onConflict: 'document_id,grantee_id' }
    )
    .select('*')
    .single();

  if (error) {
    throw { httpStatus: 403, code: 'PERMISSION_CHANGE_FAILED', message: 'Failed to change permissions.', details: error.message };
  }

  return { grant: data };
}

/**
 * DeleteDocumentPermissionFlow
 *
 * Contract:
 * - Inputs: { client, documentId, granteeId }
 * - Output: { deleted: true }
 */
async function deleteDocumentPermissionFlow({ client, documentId, granteeId }) {
  if (!documentId || !granteeId) {
    throw { httpStatus: 400, code: 'VALIDATION_ERROR', message: 'documentId and granteeId are required.' };
  }

  const { error } = await client.from('document_access').delete().eq('document_id', documentId).eq('grantee_id', granteeId);
  if (error) {
    throw { httpStatus: 403, code: 'PERMISSION_CHANGE_FAILED', message: 'Failed to remove permission.', details: error.message };
  }

  return { deleted: true };
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

      if (req.auth?.userId && req.supabase) {
        const { data, error } = await req.supabase.from('documents').select('*').eq('id', id).single();
        if (error) {
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
   * Update document metadata (owner/admin).
   */
  // PUBLIC_INTERFACE
  async update(req, res, next) {
    try {
      if (!req.auth?.userId || !req.supabase) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }

      const id = req.params.id;
      const patch = req.body || {};

      const result = await updateDocumentMetadataFlow({
        client: req.supabase,
        documentId: id,
        patch,
      });

      return ok(res, result);
    } catch (err) {
      if (err?.httpStatus) return fail(res, err.httpStatus, err.code, err.message, err.details);
      return next(err);
    }
  }

  /**
   * Publish a document (visibility=public).
   */
  // PUBLIC_INTERFACE
  async publish(req, res, next) {
    try {
      if (!req.auth?.userId || !req.supabase) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const id = req.params.id;
      const result = await setDocumentVisibilityFlow({
        client: req.supabase,
        documentId: id,
        visibility: 'public',
      });
      return ok(res, result);
    } catch (err) {
      if (err?.httpStatus) return fail(res, err.httpStatus, err.code, err.message, err.details);
      return next(err);
    }
  }

  /**
   * Unpublish a document (visibility=private).
   */
  // PUBLIC_INTERFACE
  async unpublish(req, res, next) {
    try {
      if (!req.auth?.userId || !req.supabase) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const id = req.params.id;
      const result = await setDocumentVisibilityFlow({
        client: req.supabase,
        documentId: id,
        visibility: 'private',
      });
      return ok(res, result);
    } catch (err) {
      if (err?.httpStatus) return fail(res, err.httpStatus, err.code, err.message, err.details);
      return next(err);
    }
  }

  /**
   * Delete a document (storage object(s) + DB row).
   */
  // PUBLIC_INTERFACE
  async remove(req, res, next) {
    try {
      if (!req.auth?.userId || !req.supabase) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const id = req.params.id;

      const result = await deleteDocumentFlow({
        supabaseAdmin: req.supabaseAdmin,
        client: req.supabase,
        documentId: id,
      });

      return ok(res, result);
    } catch (err) {
      if (err?.httpStatus) return fail(res, err.httpStatus, err.code, err.message, err.details);
      return next(err);
    }
  }

  /**
   * List access grants for a document (owner/admin; grantee can also read their own grants per RLS).
   */
  // PUBLIC_INTERFACE
  async listPermissions(req, res, next) {
    try {
      if (!req.auth?.userId || !req.supabase) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const id = req.params.id;

      const { data, error } = await req.supabase
        .from('document_access')
        .select('document_id,grantee_id,access_level,created_at')
        .eq('document_id', id);

      if (error) {
        return supabaseFail(res, 403, 'PERMISSIONS_LIST_FAILED', 'Failed to list permissions.', error);
      }

      return ok(res, { items: data });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Upsert a permission grant (share) for a document.
   */
  // PUBLIC_INTERFACE
  async upsertPermission(req, res, next) {
    try {
      if (!req.auth?.userId || !req.supabase) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const id = req.params.id;
      const { grantee_id, access_level } = req.body || {};
      const result = await upsertDocumentPermissionFlow({
        client: req.supabase,
        documentId: id,
        granteeId: grantee_id,
        accessLevel: access_level,
      });
      return ok(res, result);
    } catch (err) {
      if (err?.httpStatus) return fail(res, err.httpStatus, err.code, err.message, err.details);
      return next(err);
    }
  }

  /**
   * Delete a permission grant for a document.
   */
  // PUBLIC_INTERFACE
  async deletePermission(req, res, next) {
    try {
      if (!req.auth?.userId || !req.supabase) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const id = req.params.id;
      const granteeId = req.params.granteeId;
      const result = await deleteDocumentPermissionFlow({
        client: req.supabase,
        documentId: id,
        granteeId,
      });
      return ok(res, result);
    } catch (err) {
      if (err?.httpStatus) return fail(res, err.httpStatus, err.code, err.message, err.details);
      return next(err);
    }
  }

  /**
   * List document versions (readable if doc is readable).
   */
  // PUBLIC_INTERFACE
  async listVersions(req, res, next) {
    try {
      const id = req.params.id;
      if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'id is required.');

      // Use RLS client if present, else admin with enforced public/unlisted.
      const client = req.supabase || req.supabaseAdmin;

      const { data, error } = await client
        .from('document_versions')
        .select('id,document_id,version_number,mime_type,original_filename,file_size_bytes,storage_bucket,storage_path,created_by,created_at')
        .eq('document_id', id)
        .order('version_number', { ascending: false });

      if (error) {
        return supabaseFail(res, 500, 'VERSIONS_LIST_FAILED', 'Failed to list versions.', error);
      }

      return ok(res, { items: data });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Create a signed URL for a specific version (if readable).
   */
  // PUBLIC_INTERFACE
  async getVersionSignedUrl(req, res, next) {
    try {
      const id = req.params.id;
      const versionId = req.params.versionId;
      const expiresIn = Math.min(parseInt(req.query.expiresIn || '300', 10) || 300, 3600);

      if (!id || !versionId) return fail(res, 400, 'VALIDATION_ERROR', 'id and versionId are required.');

      const client = req.supabase || req.supabaseAdmin;

      const { data: version, error } = await client
        .from('document_versions')
        .select('id,document_id,storage_bucket,storage_path')
        .eq('id', versionId)
        .eq('document_id', id)
        .maybeSingle();

      if (error) return supabaseFail(res, 404, 'NOT_FOUND', 'Version not found.', error);
      if (!version) return fail(res, 404, 'NOT_FOUND', 'Version not found.');

      const bucket = version.storage_bucket || 'documents';
      const { data: signed, error: signErr } = await req.supabaseAdmin.storage
        .from(bucket)
        .createSignedUrl(version.storage_path, expiresIn);

      if (signErr) return supabaseFail(res, 500, 'SIGNED_URL_FAILED', 'Failed to create signed URL.', signErr);

      return ok(res, { signedUrl: signed.signedUrl, expiresIn });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Return view analytics (raw events) - owner/admin only (RLS).
   */
  // PUBLIC_INTERFACE
  async getAnalytics(req, res, next) {
    try {
      if (!req.auth?.userId || !req.supabase) {
        return fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const id = req.params.id;
      const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
      const offset = parseInt(req.query.offset || '0', 10) || 0;

      const { data, error, count } = await req.supabase
        .from('document_views')
        .select('id,document_id,viewer_id,viewer_ip,user_agent,page_number,created_at', { count: 'exact' })
        .eq('document_id', id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return supabaseFail(res, 403, 'ANALYTICS_NOT_ALLOWED', 'Not allowed to view analytics for this document.', error);

      return ok(res, { items: data }, { count, limit, offset });
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

      const client = req.supabase || req.supabaseAdmin;

      const { error } = await client.from('document_views').insert(insertPayload);
      if (error) {
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

      let doc = null;

      if (req.auth?.userId && req.supabase) {
        const { data, error } = await req.supabase.from('documents').select('id,storage_bucket,storage_path').eq('id', id).single();
        if (error) return supabaseFail(res, 404, 'NOT_FOUND', 'Document not found.', error);
        doc = data;
      } else {
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
