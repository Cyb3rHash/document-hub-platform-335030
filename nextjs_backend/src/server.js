/**
 * Ensure local development and self-hosted deployments load environment variables
 * from a `.env` file.
 *
 * IMPORTANT:
 * - In managed platforms (Railway/Vercel/etc.), env vars are injected by the platform.
 * - In local dev/preview, `.env` must be loaded explicitly or `process.env.*` will be empty.
 *
 * This is intentionally done at the entrypoint so all downstream modules see populated env.
 */
require('dotenv').config();

const app = require('./app');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });

module.exports = server;
