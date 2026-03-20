const express = require('express');
const multer = require('multer');
const documentsController = require('../controllers/documents');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/**
 * @swagger
 * tags:
 *   - name: Documents
 *     description: Document upload, metadata, listing/search, lifecycle management, permissions/sharing, versions, analytics, and signed URLs
 */

/**
 * @swagger
 * /documents:
 *   get:
 *     tags: [Documents]
 *     summary: List/search documents
 *     description: Lists documents. Anonymous users only see public/unlisted documents.
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Search query applied to title/description
 *       - in: query
 *         name: visibility
 *         schema: { type: string, enum: [private, public, unlisted] }
 *       - in: query
 *         name: owner
 *         schema: { type: string }
 *         description: Use 'me' for your docs; arbitrary uuid requires admin
 *       - in: query
 *         name: sort
 *         schema: { type: string }
 *         description: "created_at:desc | created_at:asc | view_count:desc | title:asc"
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Document list
 */
router.get('/', documentsController.list.bind(documentsController));

/**
 * @swagger
 * /documents:
 *   post:
 *     tags: [Documents]
 *     summary: Upload a document (multipart)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, title]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               visibility:
 *                 type: string
 *                 enum: [private, public, unlisted]
 *               disable_download:
 *                 type: boolean
 *               watermark_text:
 *                 type: string
 *     responses:
 *       201:
 *         description: Created document
 */
router.post('/', requireAuth, upload.single('file'), documentsController.upload.bind(documentsController));

/**
 * @swagger
 * /documents/{id}:
 *   get:
 *     tags: [Documents]
 *     summary: Get document metadata
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Document metadata
 *       404:
 *         description: Not found
 */
router.get('/:id', documentsController.get.bind(documentsController));

/**
 * @swagger
 * /documents/{id}:
 *   patch:
 *     tags: [Documents]
 *     summary: Update document metadata (owner/admin)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Metadata patch object
 *             properties:
 *               title: { type: string }
 *               description: { type: string, nullable: true }
 *               visibility: { type: string, enum: [private, public, unlisted] }
 *               disable_download: { type: boolean }
 *               watermark_text: { type: string, nullable: true }
 *               status: { type: string, description: "Admin/processing only; RLS will restrict" }
 *               page_count: { type: integer, description: "Admin/processing only; RLS will restrict" }
 *     responses:
 *       200:
 *         description: Updated document
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Not found (or not permitted)
 */
router.patch('/:id', requireAuth, express.json(), documentsController.update.bind(documentsController));

/**
 * @swagger
 * /documents/{id}:
 *   delete:
 *     tags: [Documents]
 *     summary: Delete a document (storage objects + DB row)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Not found (or not permitted)
 */
router.delete('/:id', requireAuth, documentsController.remove.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/publish:
 *   post:
 *     tags: [Documents]
 *     summary: Publish a document (sets visibility=public)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Published document
 */
router.post('/:id/publish', requireAuth, documentsController.publish.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/unpublish:
 *   post:
 *     tags: [Documents]
 *     summary: Unpublish a document (sets visibility=private)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Unpublished document
 */
router.post('/:id/unpublish', requireAuth, documentsController.unpublish.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/permissions:
 *   get:
 *     tags: [Documents]
 *     summary: List document permissions (shares)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Permission grants
 */
router.get('/:id/permissions', requireAuth, documentsController.listPermissions.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/permissions:
 *   put:
 *     tags: [Documents]
 *     summary: Upsert (add/update) a document permission grant
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [grantee_id]
 *             properties:
 *               grantee_id: { type: string, description: "User UUID to grant access to" }
 *               access_level: { type: string, enum: [viewer, editor], default: viewer }
 *     responses:
 *       200:
 *         description: Grant upserted
 */
router.put('/:id/permissions', requireAuth, express.json(), documentsController.upsertPermission.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/permissions/{granteeId}:
 *   delete:
 *     tags: [Documents]
 *     summary: Remove a document permission grant
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: granteeId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Grant removed
 */
router.delete('/:id/permissions/:granteeId', requireAuth, documentsController.deletePermission.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/versions:
 *   get:
 *     tags: [Documents]
 *     summary: List document versions
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Versions list
 */
router.get('/:id/versions', documentsController.listVersions.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/versions/{versionId}/signed-url:
 *   get:
 *     tags: [Documents]
 *     summary: Get a signed URL for a specific document version
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: versionId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: expiresIn
 *         schema: { type: integer, default: 300, maximum: 3600 }
 *     responses:
 *       200:
 *         description: Signed URL returned
 */
router.get('/:id/versions/:versionId/signed-url', documentsController.getVersionSignedUrl.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/analytics/views:
 *   get:
 *     tags: [Documents]
 *     summary: Get raw view events (owner/admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100, maximum: 500 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: View events
 */
router.get('/:id/analytics/views', requireAuth, documentsController.getAnalytics.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/view:
 *   post:
 *     tags: [Documents]
 *     summary: Record a view (increments view_count)
 *     description: Inserts a document_views event. RLS blocks views for non-viewable docs.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               page_number:
 *                 type: integer
 *                 description: Optional page number viewed
 *     responses:
 *       200:
 *         description: View recorded
 *       403:
 *         description: Not allowed
 */
router.post('/:id/view', express.json(), documentsController.recordView.bind(documentsController));

/**
 * @swagger
 * /documents/{id}/signed-url:
 *   get:
 *     tags: [Documents]
 *     summary: Get a signed URL for the document file
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: expiresIn
 *         schema: { type: integer, default: 300, maximum: 3600 }
 *     responses:
 *       200:
 *         description: Signed URL returned
 */
router.get('/:id/signed-url', documentsController.getSignedUrl.bind(documentsController));

/**
 * Admin-only: list raw storage objects for a document prefix (debug/ops).
 * This is optional but helpful for operations when storage policy behavior differs across environments.
 */
/**
 * @swagger
 * /documents/{id}/admin/storage-objects:
 *   get:
 *     tags: [Documents]
 *     summary: (Admin) Debug list storage objects for a document prefix
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Storage objects listing (best-effort)
 */
router.get('/:id/admin/storage-objects', requireAuth, requireAdmin, async (req, res) => {
  // Kept in route layer intentionally: small admin/debug adapter with no reuse needs elsewhere.
  const { ok, supabaseFail, fail } = require('../utils/http');

  const id = req.params.id;
  if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'id is required.');

  // Must resolve owner_id to compute prefix. Use admin to bypass RLS.
  const { data: doc, error: docErr } = await req.supabaseAdmin
    .from('documents')
    .select('id,owner_id,storage_bucket')
    .eq('id', id)
    .maybeSingle();

  if (docErr) return supabaseFail(res, 500, 'DOCUMENT_GET_FAILED', 'Failed to load document.', docErr);
  if (!doc) return fail(res, 404, 'NOT_FOUND', 'Document not found.');

  const bucket = doc.storage_bucket || 'documents';
  const prefix = `${doc.owner_id}/${doc.id}/`;
  const { data, error } = await req.supabaseAdmin.storage.from(bucket).list(prefix, { limit: 1000 });

  if (error) return supabaseFail(res, 500, 'STORAGE_LIST_FAILED', 'Failed to list storage objects.', error);

  return ok(res, { items: (data || []).map((o) => ({ name: o.name, id: o.id, updated_at: o.updated_at, created_at: o.created_at })) });
});

module.exports = router;
