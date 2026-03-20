const cors = require('cors');
const express = require('express');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('../swagger');
const { attachSupabaseAndAuth } = require('./middleware/auth');

// Initialize express app
const app = express();

app.set('trust proxy', true);

/**
 * CORS / Preflight handling
 *
 * Some proxy setups are sensitive to how preflight (OPTIONS) is handled. While the `cors`
 * middleware can respond to OPTIONS automatically, making this explicit ensures that:
 * - OPTIONS never reaches auth/db middleware
 * - proxies/load balancers always receive a fast 204 response from the backend
 *
 * This reduces the chance of 502s on preflight even when GET/POST would succeed.
 */
const corsOptions = {
  /**
   * Reflect the request Origin when present (safe for browser usage), otherwise allow all.
   * Note: We do NOT set `credentials: true` here, so `*` would also be valid. Reflecting
   * origin is more compatible if credentials are enabled later.
   */
  origin: (origin, cb) => cb(null, origin || '*'),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // cache preflight for 24h where supported
};

app.use(cors(corsOptions));

// Explicitly short-circuit ALL OPTIONS preflights.
app.options('*', cors(corsOptions));

app.use('/docs', swaggerUi.serve, (req, res, next) => {
  const host = req.get('host'); // may or may not include port
  let protocol = req.protocol; // http or https

  const actualPort = req.socket.localPort;
  const hasPort = host.includes(':');

  const needsPort =
    !hasPort &&
    ((protocol === 'http' && actualPort !== 80) ||
      (protocol === 'https' && actualPort !== 443));
  const fullHost = needsPort ? `${host}:${actualPort}` : host;
  protocol = req.secure ? 'https' : protocol;

  const dynamicSpec = {
    ...swaggerSpec,
    servers: [
      {
        url: `${protocol}://${fullHost}`,
      },
    ],
  };
  swaggerUi.setup(dynamicSpec)(req, res, next);
});

// Parse JSON request body
app.use(express.json());

// Attach Supabase clients + auth context (non-enforcing)
app.use(attachSupabaseAndAuth);

/**
 * Mount routes.
 *
 * The frontend calls endpoints under `/api/*` (e.g. `/api/documents`), while our OpenAPI
 * paths are defined without the `/api` prefix (e.g. `/documents`).
 *
 * To support both deployments and avoid 404/500 issues behind proxies/rewrites,
 * we mount the same router at both `/` and `/api`.
 */
app.use('/', routes);
app.use('/api', routes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    status: 'error',
    message: 'Internal Server Error',
  });
});

module.exports = app;
