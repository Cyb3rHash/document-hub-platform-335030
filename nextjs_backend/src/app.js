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
 * We intentionally use an explicit origin allowlist driven by env so that:
 * - Browsers are allowed to call the API from the frontend origin (fixes CORS/preflight issues)
 * - We avoid reflecting arbitrary origins in production
 *
 * Env:
 * - FRONTEND_URL: single allowed origin (e.g. https://<frontend-host>)
 * - CORS_ORIGINS: optional comma-separated list of allowed origins (takes precedence)
 *
 * Notes:
 * - We do NOT use cookies/credentials for auth (Bearer tokens), so `credentials: false`.
 * - We still short-circuit OPTIONS to ensure auth/db middleware is never hit for preflight.
 */
function normalizeOrigin(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function getAllowedOrigins() {
  const listRaw = process.env.CORS_ORIGINS;
  if (listRaw && String(listRaw).trim()) {
    return String(listRaw)
      .split(',')
      .map((o) => normalizeOrigin(o))
      .filter(Boolean);
  }

  const single = normalizeOrigin(process.env.FRONTEND_URL || process.env.SITE_URL);
  return single ? [single] : [];
}

const allowedOrigins = getAllowedOrigins();

const corsOptions = {
  origin: (origin, cb) => {
    // Non-browser requests (curl/postman) or same-origin may omit Origin; allow them.
    if (!origin) return cb(null, true);

    const normalized = normalizeOrigin(origin);

    // If no allowlist is configured, default to permissive behavior for dev/first-run.
    if (allowedOrigins.length === 0) return cb(null, true);

    if (normalized && allowedOrigins.includes(normalized)) return cb(null, true);

    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['x-request-id'],
  credentials: false,
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
