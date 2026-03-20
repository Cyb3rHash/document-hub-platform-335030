const {
  streamDocumentInlinePreviewFlow,
  documentInlinePreviewProxyHttpBoundary,
} = require('../flows/documentProxy');

/**
 * DocumentProxyController
 *
 * Provides same-origin streaming endpoints for previewing documents inline.
 * This avoids browsers blocking cross-site iframe/PDF embeds of Supabase signed URLs.
 */
class DocumentProxyController {
  /**
   * Stream a document inline via same-origin endpoint.
   *
   * Route: GET /documents/:id/preview
   *
   * Query:
   * - expiresIn?: number (seconds, default 900, max 3600)
   *
   * Auth:
   * - Anonymous users: only public/unlisted documents are streamable.
   * - Authenticated users: permissions enforced via RLS when req.supabase is available.
   */
  // PUBLIC_INTERFACE
  async previewInline(req, res) {
    return documentInlinePreviewProxyHttpBoundary({
      req,
      res,
      runFlow: async () =>
        streamDocumentInlinePreviewFlow({
          deps: {
            fetchImpl: fetch, // Node 18+ global fetch
            supabaseAdmin: req.supabaseAdmin,
            supabaseUser: req.supabase || null,
          },
          input: {
            documentId: req.params.id,
            expiresInSeconds: req.query.expiresIn,
            authUserId: req.auth?.userId || null,
          },
        }),
    });
  }
}

module.exports = new DocumentProxyController();
