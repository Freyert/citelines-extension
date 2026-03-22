/**
 * Authentication middleware supporting dual authentication:
 * 1. JWT tokens (registered users) - Authorization: Bearer <token>
 * 2. Anonymous IDs (anonymous users) - X-Anonymous-ID: <id>
 *
 * Backwards compatible: existing anonymous users continue working
 */

const User = require('../models/User');
const { verifyToken } = require('../config/jwt');
const db = require('../config/database');

// In-memory cache of banned IPs (Set of IP strings)
let bannedIpCache = new Set();
let bannedIpCacheExpiry = 0;
const BANNED_IP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Refresh the banned IP cache from the database
 */
async function refreshBannedIpCache() {
  try {
    const result = await db.query('SELECT DISTINCT host(ip_address) AS ip FROM banned_ips');
    bannedIpCache = new Set(result.rows.map(r => r.ip));
    bannedIpCacheExpiry = Date.now() + BANNED_IP_CACHE_TTL;
  } catch (err) {
    console.error('[Auth] Failed to refresh banned IP cache:', err.message);
  }
}

/**
 * Invalidate the banned IP cache (call after ban/unban)
 */
function invalidateBannedIpCache() {
  bannedIpCacheExpiry = 0;
}

/**
 * Check if an IP is banned
 * @param {string} ip
 * @returns {Promise<boolean>}
 */
async function isIpBanned(ip) {
  if (!ip) return false;
  if (Date.now() > bannedIpCacheExpiry) {
    await refreshBannedIpCache();
  }
  return bannedIpCache.has(ip);
}

/**
 * Authenticate user - supports BOTH JWT and anonymous ID
 * Tries JWT first, falls back to anonymous ID
 *
 * Banned users authenticate normally (req.user.is_banned = true)
 * so they retain read-only access. Write endpoints use rejectBannedWrites separately.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
async function authenticateUser(req, res, next) {
  try {
    // Check IP ban early
    const clientIp = req.ip || req.connection?.remoteAddress;
    if (await isIpBanned(clientIp)) {
      req.ipBanned = true;
    }

    // Strategy 1: Try JWT token first (registered users)
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      try {
        const payload = verifyToken(token);
        const user = await User.findById(payload.userId);

        if (user) {
          // Banned users authenticate normally — read-only enforced at write endpoints
          // (is_banned flag is already on the user object from the DB)

          // Check if user is suspended (temporary)
          if (user.is_suspended) {
            const suspendedUntil = user.suspended_until ? new Date(user.suspended_until) : null;

            // Check if suspension has expired
            if (suspendedUntil && suspendedUntil < new Date()) {
              // Suspension expired - auto-unsuspend
              await User.unsuspend(user.id);
              user.is_suspended = false;
            } else {
              return res.status(403).json({
                error: 'Account suspended',
                message: 'Your account is temporarily suspended. Reason: ' + (user.suspension_reason || 'No reason provided'),
                suspended: true,
                suspendedUntil: suspendedUntil
              });
            }
          }

          // Check if account has been merged into another
          if (user.auth_type === 'merged') {
            return res.status(401).json({
              error: 'Account merged',
              message: 'This account has been merged into another account. Please sign in again.',
              merged: true
            });
          }

          // Check if account has been deleted
          if (user.auth_type === 'deleted') {
            return res.status(401).json({
              error: 'Account deleted',
              message: 'This account has been deleted.',
              deleted: true
            });
          }

          req.user = user;
          req.authType = 'jwt';
          req.authMethod = 'token';
          return next();
        }
      } catch (err) {
        // Invalid JWT - log and fall through to anonymous
        console.log('[Auth] Invalid JWT token, trying anonymous:', err.message);
      }
    }

    // Strategy 2: Try anonymous ID (anonymous users)
    const anonymousId = req.headers['x-anonymous-id'];

    if (anonymousId) {
      const user = await User.findByAnonymousId(anonymousId);

      if (user) {
        // Banned users authenticate normally — read-only enforced at write endpoints

        // Check if user is suspended (temporary)
        if (user.is_suspended) {
          const suspendedUntil = user.suspended_until ? new Date(user.suspended_until) : null;

          // Check if suspension has expired
          if (suspendedUntil && suspendedUntil < new Date()) {
            // Suspension expired - auto-unsuspend
            await User.unsuspend(user.id);
            user.is_suspended = false;
          } else {
            return res.status(403).json({
              error: 'Account suspended',
              message: 'Your account is temporarily suspended. Reason: ' + (user.suspension_reason || 'No reason provided'),
              suspended: true,
              suspendedUntil: suspendedUntil
            });
          }
        }

        // Check if account has been merged into another
        if (user.auth_type === 'merged') {
          return res.status(401).json({
            error: 'Account merged',
            message: 'This account has been merged into another account. Please sign in again.',
            merged: true
          });
        }

        // Check if account has been deleted
        if (user.auth_type === 'deleted') {
          return res.status(401).json({
            error: 'Account deleted',
            message: 'This account has been deleted.',
            deleted: true
          });
        }

        req.user = user;
        req.authType = 'anonymous';
        req.authMethod = 'anonymous_id';
        return next();
      } else {
        // Anonymous ID not found - might be expired/deleted
        return res.status(401).json({
          error: 'Invalid anonymous ID',
          code: 'ANONYMOUS_ID_NOT_FOUND',
          message: 'User not found. Please register first.'
        });
      }
    }

    // No valid authentication found
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please sign in or allow extension to create anonymous account',
      hint: 'Provide either Authorization: Bearer <token> or X-Anonymous-ID: <id>'
    });

  } catch (error) {
    console.error('[Auth] Authentication error:', error);
    return res.status(500).json({
      error: 'Authentication failed',
      message: 'An error occurred during authentication'
    });
  }
}

/**
 * Optional authentication middleware
 * Doesn't fail if no auth provided - just sets req.user if available
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
async function optionalAuth(req, res, next) {
  try {
    // Try JWT first
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      try {
        const payload = verifyToken(token);
        const user = await User.findById(payload.userId);

        if (user) {
          req.user = user;
          req.authType = 'jwt';
          req.authMethod = 'token';
          return next();
        }
      } catch (err) {
        // Invalid JWT - continue without auth
      }
    }

    // Try anonymous ID
    if (!req.user) {
      const anonymousId = req.headers['x-anonymous-id'];

      if (anonymousId) {
        const user = await User.findByAnonymousId(anonymousId);

        if (user) {
          req.user = user;
          req.authType = 'anonymous';
          req.authMethod = 'anonymous_id';
        }
      }
    }

    // Continue regardless (user may be null)
    next();

  } catch (error) {
    console.error('[Auth] Optional auth error:', error);
    // Continue without auth
    next();
  }
}

/**
 * Middleware to reject writes from banned users or banned IPs.
 * Apply to POST/PUT/DELETE endpoints that modify data.
 */
function rejectBannedWrites(req, res, next) {
  if (req.user?.is_banned || req.ipBanned) {
    return res.status(403).json({
      error: 'Account suspended',
      message: 'Your account has been suspended. You cannot create or modify citations.',
      banned: true
    });
  }
  next();
}

/**
 * Backwards compatible alias for authenticateUser
 * Existing routes using authenticateAnonymous still work
 */
const authenticateAnonymous = authenticateUser;

module.exports = {
  authenticateUser,
  authenticateAnonymous,  // Backwards compatible
  optionalAuth,
  rejectBannedWrites,
  invalidateBannedIpCache
};
