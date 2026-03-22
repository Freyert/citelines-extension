require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const sharesRoutes = require('./routes/shares');
const usersRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const analyticsRoutes = require('./routes/analytics');
const reportsRoutes = require('./routes/reports');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { setupCounterResetJobs } = require('./jobs/resetCounters');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Check whether a request origin is permitted to call this API.
 *
 * Uses exact hostname matching via the URL constructor rather than
 * string.includes(). The includes() approach is exploitable: a domain
 * like 'evil-youtube.com.attacker.com' would pass an includes('youtube.com')
 * check. Combined with Access-Control-Allow-Credentials: true, a bypassed
 * origin check lets an attacker-controlled page make authenticated requests
 * on behalf of any logged-in user (confused-deputy attack).
 *
 * Railway deployment subdomains are allowed as a group because the app's
 * own hostname is determined at deploy time and is not known statically.
 * Localhost is permitted in development only to prevent accidental exposure
 * of local developer services on production builds.
 *
 * @param {string} origin - The Origin header value from the request
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    const allowedHosts = [
      'www.youtube.com',
      'studio.youtube.com',
      'youtube.com',
      'citelines.org',
      'www.citelines.org'
    ];
    if (allowedHosts.includes(hostname)) return true;
    // Allow any *.railway.app subdomain (covers preview and production deployments)
    if (hostname.endsWith('.railway.app')) return true;
    // Localhost permitted in development only — never in production builds
    if (process.env.NODE_ENV === 'development' && hostname === 'localhost') return true;
    return false;
  } catch {
    // Malformed origin — deny rather than crash
    return false;
  }
}

// Trust Railway proxy for rate limiting and X-Forwarded-For headers
// Use 1 (not true) to avoid ERR_ERL_PERMISSIVE_TRUST_PROXY from express-rate-limit
app.set('trust proxy', 1);

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Chrome Private Network Access (PNA) middleware.
//
// Browsers implementing the Private Network Access spec (Chrome 94+) send a
// preflight with Access-Control-Request-Private-Network: true before allowing
// a public web page to reach a private/local network address. Without this
// middleware the extension would be blocked when the backend runs on localhost
// during development.
//
// Access-Control-Allow-Credentials must be true here so the browser forwards
// the user's auth cookie/token on credentialed cross-origin requests. This is
// only safe because isAllowedOrigin() enforces an exact-match allowlist —
// reflecting an arbitrary origin with credentials enabled would be a
// confused-deputy vulnerability.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && (isAllowedOrigin(origin) || origin.startsWith('chrome-extension://'))) {
    // Echo the validated origin back — required by the CORS spec when
    // credentials are enabled (a wildcard '*' is not permitted with credentials).
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anonymous-ID, Authorization');
    // Required response header for the PNA preflight handshake.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  // Respond immediately to preflight requests — no need to reach route handlers.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// CORS configuration — secondary enforcement layer via the `cors` package.
//
// The PNA middleware above handles most cross-origin requests, but the `cors`
// package provides a second enforcement point and sets the correct headers for
// non-preflight responses. Both layers use isAllowedOrigin() so the allowlist
// stays in one place.
//
// CORS_ORIGINS env var allows operators to add extra allowed origins at deploy
// time without a code change (e.g. for staging or preview environments).
const corsOptions = {
  origin: function (origin, callback) {
    // No origin header means the request came from a same-origin context,
    // a mobile app, or a server-side tool like curl — allow it.
    if (!origin) return callback(null, true);

    // Chrome extension pages use chrome-extension:// origins, which are not
    // HTTP URLs and won't match isAllowedOrigin(), so check them separately.
    if (origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }

    // Primary allowlist check — exact hostname matching (see isAllowedOrigin).
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    // Operator-supplied origins via environment variable (comma-separated).
    const allowedOrigins = process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
      : [];

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Anonymous-ID', 'Authorization']
};

app.use(cors(corsOptions));

// Security headers — applied to every response.
app.use((req, res, next) => {
  // Prevent browsers from MIME-sniffing a response away from the declared
  // Content-Type. Without this a response served as text/plain could be
  // interpreted as text/javascript and executed.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent this site from being embedded in an <iframe>, which is the
  // primary vector for clickjacking attacks against the admin dashboard.
  res.setHeader('X-Frame-Options', 'DENY');

  // Limit the Referer header to origin + path (no query string) for
  // same-origin requests, and origin-only for cross-origin requests.
  // This prevents sensitive URL parameters from leaking to third parties.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Legacy XSS filter hint for older browsers that support it. Modern
  // browsers rely on CSP instead, but this costs nothing to include.
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Instruct browsers that have visited over HTTPS to refuse HTTP connections
  // for the next year, preventing protocol-downgrade attacks. Only sent over
  // HTTPS — sending it over HTTP would poison the HSTS state incorrectly.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
});

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { error: 'Too many requests', message: 'Too many requests from this IP, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// More relaxed rate limiting for collaborative mode
// Only limit write operations (POST/PUT/DELETE), not reads (GET)
const writeShareLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 write operations per hour per IP
  message: 'Too many shares created/updated from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skip: (req) => req.method === 'GET' // Don't rate limit GET requests
});

const analyticsLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many analytics requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', generalLimiter);
app.use('/api/shares', writeShareLimiter);
app.use('/api/analytics', analyticsLimiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Serve static files (admin dashboard)
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/shares', sharesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/reports', reportsRoutes);

// 404 handler
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`YouTube Annotator API server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);

  // Setup cron jobs for resetting rate limit counters
  setupCounterResetJobs();
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Promise Rejection:', err);
  // In production, you might want to exit the process
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;
