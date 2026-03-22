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
    if (hostname.endsWith('.railway.app')) return true;
    if (process.env.NODE_ENV === 'development' && hostname === 'localhost') return true;
    return false;
  } catch {
    return false;
  }
}

// Trust Railway proxy for rate limiting and X-Forwarded-For headers
// Use 1 (not true) to avoid ERR_ERL_PERMISSIVE_TRUST_PROXY from express-rate-limit
app.set('trust proxy', 1);

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Chrome Private Network Access (PNA) - Allow YouTube.com to access localhost
// Required for extensions to make API calls from public websites to localhost
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Allow YouTube.com, chrome extensions, and citelines.org
  if (origin && (isAllowedOrigin(origin) || origin.startsWith('chrome-extension://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anonymous-ID, Authorization');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// CORS configuration (as backup)
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Allow chrome-extension:// origins
    if (origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }

    // Allow validated origins (exact hostname match)
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    // Allow configured origins
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

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
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
