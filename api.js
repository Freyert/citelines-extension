/**
 * Citelines API Client
 * Handles communication with the backend API
 */

class AnnotatorAPI {
  constructor() {
    // Production Railway backend
    this.baseUrl = 'https://citelines-extension-production.up.railway.app/api';
    this.anonymousId = null;
    this.authManager = null; // Will be set after authManager is initialized
  }

  /**
   * Set auth manager reference
   * @param {AuthManager} manager
   */
  setAuthManager(manager) {
    this.authManager = manager;
  }

  /**
   * Get authentication headers (JWT or anonymous ID)
   * @returns {Promise<Object>} Headers object
   */
  async getAuthHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };

    // Priority 1: Use JWT token if logged in
    if (this.authManager && this.authManager.isLoggedIn()) {
      headers['Authorization'] = `Bearer ${this.authManager.getToken()}`;
      return headers;
    }

    // Priority 2: Use anonymous ID
    await this.initialize();
    if (this.anonymousId) {
      headers['X-Anonymous-ID'] = this.anonymousId;
    }

    return headers;
  }

  /**
   * Get storage key for anonymous ID (different for incognito mode)
   * @returns {string} Storage key
   */
  getStorageKey() {
    // Use different storage keys for incognito vs regular mode
    // This ensures each context has its own anonymous ID
    const isIncognito = chrome.extension?.inIncognitoContext ?? false;
    return isIncognito ? 'anonymousId_incognito' : 'anonymousId';
  }

  /**
   * Initialize the API client - get or create anonymous ID
   * @returns {Promise<string>} Anonymous ID
   */
  async initialize() {
    if (this.anonymousId) {
      return this.anonymousId;
    }

    const storageKey = this.getStorageKey();
    const isIncognito = chrome.extension?.inIncognitoContext ?? false;

    // Try to get existing anonymous ID from storage
    const result = await chrome.storage.local.get([storageKey]);

    if (result[storageKey]) {
      this.anonymousId = result[storageKey];
      console.log(`[DEBUG] Using existing anonymous ID (${isIncognito ? 'incognito' : 'regular'}):`, this.anonymousId.substring(0, 8) + '...');
      return this.anonymousId;
    }

    // Register new anonymous user
    try {
      const data = await this.registerAnonymousUser();
      this.anonymousId = data.anonymousId;

      // Save to storage with appropriate key
      await chrome.storage.local.set({ [storageKey]: this.anonymousId });
      console.log(`[DEBUG] Registered new anonymous user (${isIncognito ? 'incognito' : 'regular'}):`, this.anonymousId.substring(0, 8) + '...');

      return this.anonymousId;
    } catch (error) {
      console.error('Failed to initialize API:', error);
      throw error;
    }
  }

  /**
   * Register a new anonymous user
   * @returns {Promise<Object>} User data
   */
  async registerAnonymousUser() {
    const response = await fetch(`${this.baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to register user');
    }

    return await response.json();
  }

  /**
   * Create a share
   * @param {string} videoId - YouTube video ID
   * @param {Array} annotations - Array of annotation objects
   * @param {string} title - Optional title
   * @returns {Promise<Object>} Share data with token and URL
   */
  async createShare(videoId, annotations, title = null) {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/shares`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        videoId,
        title,
        annotations,
        isPublic: true
      })
    });

    if (!response.ok) {
      const error = await response.json();

      // If user not found (401), re-register and retry
      if (response.status === 401 && error.message && error.message.includes('User not found')) {
        console.log('[DEBUG] User not found in database, re-registering...');

        // Clear old anonymous ID and re-register
        const storageKey = this.getStorageKey();
        await chrome.storage.local.remove([storageKey]);
        this.anonymousId = null;

        // Re-initialize (will register new user)
        await this.initialize();

        // Retry the create share request
        return this.createShare(videoId, annotations, title);
      }

      // Handle suspension/ban errors
      if (response.status === 403 && (error.suspended || error.banned)) {
        const customError = new Error(error.message || 'Account suspended');
        customError.suspended = error.suspended;
        customError.banned = error.banned;
        customError.suspendedUntil = error.suspendedUntil;
        throw customError;
      }

      throw new Error(error.message || 'Failed to create share');
    }

    return await response.json();
  }

  /**
   * Get shared annotations by token
   * @param {string} shareToken - Share token from URL
   * @returns {Promise<Object>} Share data with annotations
   */
  async getShare(shareToken) {
    const headers = await this.getAuthHeaders();
    delete headers['Content-Type']; // Not needed for GET

    const response = await fetch(`${this.baseUrl}/shares/${shareToken}`, {
      headers
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get share');
    }

    return await response.json();
  }

  /**
   * Get shares for a video
   * @param {string} videoId - YouTube video ID
   * @param {number} limit - Max results
   * @param {number} offset - Pagination offset
   * @returns {Promise<Object>} List of shares
   */
  async getSharesForVideo(videoId, limit = 50, offset = 0) {
    const headers = await this.getAuthHeaders();
    delete headers['Content-Type'];

    const response = await fetch(
      `${this.baseUrl}/shares/video/${videoId}?limit=${limit}&offset=${offset}`,
      { headers }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get shares');
    }

    return await response.json();
  }

  /**
   * Get current user's shares
   * @param {number} limit - Max results
   * @param {number} offset - Pagination offset
   * @returns {Promise<Object>} List of user's shares
   */
  async getMyShares(limit = 50, offset = 0) {
    const headers = await this.getAuthHeaders();
    delete headers['Content-Type']; // Not needed for GET

    const response = await fetch(
      `${this.baseUrl}/shares/me?limit=${limit}&offset=${offset}`,
      {
        headers
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get shares');
    }

    return await response.json();
  }

  /**
   * Update a share
   * @param {string} shareToken - Share token
   * @param {Object} updates - Fields to update (title, annotations, isPublic)
   * @returns {Promise<Object>} Updated share data
   */
  async updateShare(shareToken, updates) {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/shares/${shareToken}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(updates)
    });

    if (!response.ok) {
      const error = await response.json();

      // Handle suspension/ban errors
      if (response.status === 403 && (error.suspended || error.banned)) {
        const customError = new Error(error.message || 'Account suspended');
        customError.suspended = error.suspended;
        customError.banned = error.banned;
        customError.suspendedUntil = error.suspendedUntil;
        throw customError;
      }

      throw new Error(error.message || 'Failed to update share');
    }

    return await response.json();
  }

  /**
   * Delete a share
   * @param {string} shareToken - Share token
   * @returns {Promise<Object>} Deletion confirmation
   */
  async deleteShare(shareToken) {
    const headers = await this.getAuthHeaders();
    delete headers['Content-Type']; // Not needed for DELETE

    const response = await fetch(`${this.baseUrl}/shares/${shareToken}`, {
      method: 'DELETE',
      headers
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to delete share');
    }

    return await response.json();
  }

  /**
   * Login or register via YouTube OAuth access token
   * @param {string} accessToken
   * @param {string|null} displayName
   * @param {string|null} anonymousId
   * @returns {Promise<Object>} Login/register result
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
    return data;
  }

  /**
   * Connect a YouTube channel to the current logged-in account
   * @param {string} accessToken - Google OAuth access token
   * @returns {Promise<Object>} Updated channel info
   */
  async connectYouTube(accessToken) {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/auth/youtube/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ accessToken })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || data.message || 'Failed to connect YouTube channel');
    }
    return data;
  }

  /**
   * Edit annotation fields (updates a single annotation within a share)
   * @param {string} shareToken - Share token
   * @param {string} annotationId - Annotation ID within the share
   * @param {Object} changes - Changes to apply: { text?: string, citation?: {...} }
   * @returns {Promise<Object>} Updated share data
   */
  async editAnnotation(shareToken, annotationId, changes) {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/shares/${shareToken}/annotations/${annotationId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(changes)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to edit annotation');
    }

    return await response.json();
  }

  /**
   * Edit annotation text (backward-compatible wrapper)
   * @param {string} shareToken - Share token
   * @param {string} annotationId - Annotation ID within the share
   * @param {string} newText - New annotation text
   * @returns {Promise<Object>} Updated share data
   */
  async editAnnotationText(shareToken, annotationId, newText) {
    return this.editAnnotation(shareToken, annotationId, { text: newText });
  }

  /**
   * Report a citation
   * @param {string} shareToken - Share token
   * @param {string} annotationId - Annotation ID
   * @param {string} reason - Report reason
   * @param {string} details - Additional details
   * @returns {Promise<Object>} Report result
   */
  async reportCitation(shareToken, annotationId, reason, details = '') {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/reports`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        shareToken,
        annotationId,
        reportType: 'report',
        reason,
        details
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to submit report');
    }

    return await response.json();
  }

  /**
   * Suggest an edit to a citation
   * @param {string} shareToken - Share token
   * @param {string} annotationId - Annotation ID
   * @param {string} suggestedText - Suggested replacement text
   * @param {string} reason - Reason for suggestion
   * @returns {Promise<Object>} Suggestion result
   */
  async suggestEdit(shareToken, annotationId, suggestedText, reason = '') {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/reports`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        shareToken,
        annotationId,
        reportType: 'suggestion',
        suggestedText,
        reason
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to submit suggestion');
    }

    return await response.json();
  }

  /**
   * Get the current user's pending suggestion for a specific annotation
   * @param {string} shareToken
   * @param {string} annotationId
   * @returns {Promise<Object>} { suggestion: { id, suggestedText, reason, createdAt } | null }
   */
  async getMySuggestion(shareToken, annotationId) {
    const headers = await this.getAuthHeaders();
    delete headers['Content-Type'];

    const response = await fetch(
      `${this.baseUrl}/reports/my-suggestion/${shareToken}/${encodeURIComponent(annotationId)}`,
      { headers }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get suggestion');
    }

    return await response.json();
  }

  /**
   * Get all pending suggestions for a share (owner only)
   * @param {string} shareToken
   * @returns {Promise<Object>} { suggestions: [...] }
   */
  async getSuggestions(shareToken) {
    const headers = await this.getAuthHeaders();
    delete headers['Content-Type'];

    const response = await fetch(
      `${this.baseUrl}/reports/suggestions/${shareToken}`,
      { headers }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get suggestions');
    }

    return await response.json();
  }

  /**
   * Update an existing suggestion
   * @param {string} reportId
   * @param {string} suggestedText - JSON string of changes
   * @param {string} reason
   * @returns {Promise<Object>}
   */
  async updateSuggestion(reportId, suggestedText, reason = '') {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/reports/${reportId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ suggestedText, reason })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to update suggestion');
    }

    return await response.json();
  }

  /**
   * Accept a suggestion (citation owner only)
   * @param {string} reportId
   * @returns {Promise<Object>}
   */
  async acceptSuggestion(reportId) {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/reports/${reportId}/accept`, {
      method: 'POST',
      headers
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to accept suggestion');
    }

    return await response.json();
  }

  /**
   * Dismiss a suggestion (citation owner only)
   * @param {string} reportId
   * @returns {Promise<Object>}
   */
  async dismissSuggestion(reportId) {
    const headers = await this.getAuthHeaders();

    const response = await fetch(`${this.baseUrl}/reports/${reportId}/dismiss`, {
      method: 'POST',
      headers
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to dismiss suggestion');
    }

    return await response.json();
  }

  /**
   * Check API health
   * @returns {Promise<Object>} Health status
   */
  async checkHealth() {
    const response = await fetch(`${this.baseUrl}/health`);

    if (!response.ok) {
      throw new Error('API health check failed');
    }

    return await response.json();
  }
}

// Create singleton instance
const api = new AnnotatorAPI();
window.api = api;
