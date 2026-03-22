/**
 * Citelines Authentication Manager
 * Handles JWT token storage and user authentication
 */

class AuthManager {
  constructor() {
    this.token = null;
    this.user = null;
    this.baseUrl = 'https://citelines-extension-production.up.railway.app/api';
  }

  /**
   * Initialize auth manager - load token from storage
   * @returns {Promise<boolean>} True if user is logged in
   */
  async initialize() {
    const result = await chrome.storage.session.get(['jwtToken', 'currentUser']);

    if (result.jwtToken && result.currentUser) {
      this.token = result.jwtToken;
      this.user = result.currentUser;

      // Verify token is still valid
      const isValid = await this.verifyToken();
      if (isValid) {
        console.log('[Auth] Logged in as:', this.user.displayName);
        return true;
      } else {
        // Token expired, clear it
        await this.logout();
        return false;
      }
    }

    return false;
  }

  /**
   * Check if user is currently logged in
   * @returns {boolean}
   */
  isLoggedIn() {
    return this.token !== null && this.user !== null;
  }

  /**
   * Get current user info
   * @returns {Object|null}
   */
  getCurrentUser() {
    return this.user;
  }

  /**
   * Get JWT token
   * @returns {string|null}
   */
  getToken() {
    return this.token;
  }

  /**
   * Register a new account (or upgrade anonymous account)
   * @param {Object} params - { email, password, displayName, anonymousId? }
   * @returns {Promise<Object>} Registration result
   */
  async register({ email, password, displayName, anonymousId = null }) {
    const response = await fetch(`${this.baseUrl}/auth/register-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        password,
        displayName,
        anonymousId
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || error.message || 'Registration failed');
    }

    const data = await response.json();
    return data;
  }

  /**
   * Verify email with token
   * @param {string} token - Verification token from email
   * @returns {Promise<Object>}
   */
  async verifyEmail(token) {
    const response = await fetch(`${this.baseUrl}/auth/verify-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || error.message || 'Verification failed');
    }

    return await response.json();
  }

  /**
   * Login or register via YouTube OAuth access token
   * @param {string} accessToken - Google OAuth access token
   * @param {string|null} displayName - Optional display name override
   * @param {string|null} anonymousId - Optional anonymous ID to migrate
   * @returns {Promise<Object>} Response (may include needsDisplayName: true)
   */
  async loginWithYouTube(accessToken, displayName = null, anonymousId = null) {
    const body = { accessToken };
    if (displayName) body.displayName = displayName;
    if (anonymousId) body.anonymousId = anonymousId;

    const response = await fetch(`${this.baseUrl}/auth/youtube`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || 'YouTube login failed');
    }

    // If needs display name, return the prompt data without storing
    if (data.needsDisplayName) {
      return data;
    }

    // Store token and user info
    this.token = data.token;
    this.user = data.user;

    await chrome.storage.session.set({
      jwtToken: this.token,
      currentUser: this.user
    });

    // Clear the anonymous ID from storage. The anonymous account was upgraded to
    // YouTube-auth and now has youtube_channel_id set. If we kept the anonymous ID,
    // post-logout sessions would reuse that account and all new citations would
    // incorrectly appear as creator citations (orange). A fresh anonymous account
    // is created automatically on next use.
    const storageKey = api.getStorageKey();
    await chrome.storage.local.remove([storageKey]);
    api.anonymousId = null;

    console.log('[Auth] Logged in via YouTube as:', this.user.displayName);
    return data;
  }

  /**
   * Check if the current user is banned (permanently suspended)
   * @returns {boolean}
   */
  isBanned() {
    return !!(this.user?.isBanned);
  }

  /**
   * Get the YouTube channel ID for the current user
   * @returns {string|null}
   */
  getYouTubeChannelId() {
    return this.user?.youtubeChannelId || null;
  }

  /**
   * Check if current user has a verified YouTube channel
   * @returns {boolean}
   */
  isYouTubeVerified() {
    return !!(this.user?.youtubeVerified);
  }

  /**
   * Update stored user with YouTube channel info after connecting
   * @param {string} channelId
   * @param {string} channelTitle
   */
  async setYouTubeChannel(channelId, channelTitle) {
    if (!this.user) return;
    this.user = {
      ...this.user,
      youtubeChannelId: channelId,
      youtubeVerified: true,
      youtubeChannelTitle: channelTitle
    };
    await chrome.storage.session.set({ currentUser: this.user });

    // Clear anonymous ID — this account now has youtube_channel_id set, so
    // post-logout anonymous sessions must use a fresh account (same reason as
    // YouTube OAuth login above).
    const storageKey = api.getStorageKey();
    await chrome.storage.local.remove([storageKey]);
    api.anonymousId = null;
  }

  /**
   * Merge a separate YouTube account into the current logged-in account.
   * Launches YouTube OAuth, then calls POST /api/auth/merge with the access token.
   * On success, updates stored JWT and user info.
   * @param {string} accessToken - Google OAuth access token
   * @returns {Promise<Object>} Merge result with updated user
   */
  async mergeWithYouTube(accessToken) {
    const response = await fetch(`${this.baseUrl}/auth/merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ accessToken })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || 'Merge failed');
    }

    // Update stored token and user
    this.token = data.token;
    this.user = data.user;

    await chrome.storage.session.set({
      jwtToken: this.token,
      currentUser: this.user
    });

    console.log('[Auth] Accounts merged, now logged in as:', this.user.displayName);
    return data;
  }

  /**
   * Login with email and password
   * @param {string} email
   * @param {string} password
   * @returns {Promise<Object>} User data and token
   */
  async login(email, password) {
    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || error.message || 'Login failed');
    }

    const data = await response.json();

    // Store token and user info
    this.token = data.token;
    this.user = data.user;

    await chrome.storage.session.set({
      jwtToken: this.token,
      currentUser: this.user
    });

    console.log('[Auth] Logged in successfully as:', this.user.displayName);
    return data;
  }

  /**
   * Logout - clear token and user data
   * @returns {Promise<void>}
   */
  async logout() {
    this.token = null;
    this.user = null;

    await chrome.storage.session.remove(['jwtToken', 'currentUser']);
    console.log('[Auth] Logged out');
  }

  /**
   * Request password reset
   * @param {string} email
   * @returns {Promise<Object>}
   */
  async forgotPassword(email) {
    const response = await fetch(`${this.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || error.message || 'Request failed');
    }

    return await response.json();
  }

  /**
   * Reset password with token
   * @param {string} token
   * @param {string} newPassword
   * @returns {Promise<Object>}
   */
  async resetPassword(token, newPassword) {
    const response = await fetch(`${this.baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token, newPassword })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || error.message || 'Reset failed');
    }

    return await response.json();
  }

  /**
   * Verify current token is still valid
   * @returns {Promise<boolean>}
   */
  async verifyToken() {
    if (!this.token) return false;

    try {
      const response = await fetch(`${this.baseUrl}/shares/me?limit=1`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      // Only treat an explicit 401 as an invalid token — not network errors
      if (response.status === 401) return false;
      if (!response.ok) return false;
      return true;
    } catch (error) {
      // Network error — assume token is still valid to avoid spurious logouts
      console.warn('[Auth] Token verification request failed, assuming valid:', error);
      return true;
    }
  }

  /**
   * Get account expiry information
   * @returns {Promise<Object|null>} Expiry info or null if logged in
   */
  async getExpiryInfo() {
    // Only relevant for anonymous users
    if (this.isLoggedIn()) {
      return null;
    }

    try {
      const response = await fetch(`${this.baseUrl}/auth/expiry-info`, {
        headers: {
          'X-Anonymous-ID': await api.initialize()
        }
      });

      if (!response.ok) return null;

      return await response.json();
    } catch (error) {
      console.error('[Auth] Failed to get expiry info:', error);
      return null;
    }
  }
}

// Create singleton instance
const authManager = new AuthManager();
window.authManager = authManager;
