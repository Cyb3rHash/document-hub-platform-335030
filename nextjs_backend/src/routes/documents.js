const express = require('express');
const multer = require('multer');
const documentsController = require('../controllers/documents');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/**
 * @swagger
 * tags:
 *   - name: Documents
 *     description: Document upload, metadata, listing/search, view counting, and signed URLs
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

module.exports = router;

