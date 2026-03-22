const express = require('express');
const Share = require('../models/Share');
const Report = require('../models/Report');
const { authenticateAnonymous, optionalAuth, rejectBannedWrites } = require('../middleware/auth');
const { generateUniqueShareToken } = require('../utils/tokenGenerator');
const {
  isValidVideoId,
  validateAnnotations,
  isValidTitle,
  isValidShareToken,
  sanitizeText
} = require('../utils/validator');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  rateLimitCitations,
  incrementCitationCount,
  getRateLimitStats
} = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * POST /api/shares
 * Create a new share
 * Requires authentication
 */
router.post('/', authenticateAnonymous, rejectBannedWrites, rateLimitCitations, asyncHandler(async (req, res) => {
  const { videoId, title, annotations, isPublic = true } = req.body;

  // Validate video ID
  if (!isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Invalid video ID',
      message: 'Video ID must be 11 characters (YouTube format)'
    });
  }

  // Validate annotations
  const annotationsValidation = validateAnnotations(annotations);
  if (!annotationsValidation.valid) {
    return res.status(400).json({
      error: 'Invalid annotations',
      message: annotationsValidation.error
    });
  }

  // Validate title
  if (!isValidTitle(title)) {
    return res.status(400).json({
      error: 'Invalid title',
      message: 'Title must be less than 255 characters'
    });
  }

  // Generate unique share token
  const shareToken = await generateUniqueShareToken(
    (token) => Share.exists(token)
  );

  // Sanitize title if provided
  const sanitizedTitle = title ? sanitizeText(title) : null;

  // Create share
  const share = await Share.create({
    shareToken,
    userId: req.user.id,
    videoId,
    title: sanitizedTitle,
    annotations,
    isPublic
  });

  // Increment citation count (async, don't wait)
  incrementCitationCount(req.user.id, videoId).catch(err => {
    console.error('[Shares] Error incrementing citation count:', err);
  });

  res.status(201).json({
    shareToken: share.share_token,
    shareUrl: `https://youtube.com/watch?v=${videoId}&share=${share.share_token}`,
    videoId: share.video_id,
    title: share.title,
    annotationCount: share.annotations.length,
    createdAt: share.created_at
  });
}));

/**
 * GET /api/shares/me
 * List current user's shares
 * Requires authentication
 */
router.get('/me', authenticateAnonymous, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;

  // Find user's shares
  const shares = await Share.findByUserId(req.user.id, limit, offset);

  // Format response — include annotations for citation-level display
  const formattedShares = shares.map(share => ({
    shareToken: share.share_token,
    videoId: share.video_id,
    title: share.title,
    annotations: (share.annotations || []).filter(a => !a.deleted_at),
    annotationCount: share.annotations.length,
    isPublic: share.is_public,
    viewCount: share.view_count,
    createdAt: share.created_at,
    updatedAt: share.updated_at
  }));

  res.json({
    shares: formattedShares,
    count: formattedShares.length,
    limit,
    offset
  });
}));

/**
 * GET /api/shares/:token
 * Get shared annotations by token (public endpoint)
 */
router.get('/:token', optionalAuth, asyncHandler(async (req, res) => {
  const { token } = req.params;

  // Validate token format
  if (!isValidShareToken(token)) {
    return res.status(400).json({
      error: 'Invalid share token',
      message: 'Share token must be 8 alphanumeric characters'
    });
  }

  // Find share
  const share = await Share.findByToken(token);

  if (!share) {
    return res.status(404).json({
      error: 'Share not found',
      message: 'This share does not exist or has been deleted'
    });
  }

  // Check if share is public
  if (!share.is_public) {
    // Only owner can view private shares
    if (!req.user || req.user.id !== share.user_id) {
      return res.status(403).json({
        error: 'Private share',
        message: 'This share is private'
      });
    }
  }

  // Increment view count (async, don't wait)
  Share.incrementViewCount(token).catch(err => {
    console.error('Error incrementing view count:', err);
  });

  const isOwner = req.user && req.user.id === share.user_id;

  res.json({
    shareToken: share.share_token,
    videoId: share.video_id,
    title: share.title,
    annotations: share.annotations,
    viewCount: share.view_count,
    createdAt: share.created_at,
    isOwner,
    userId: share.user_id,
    creatorDisplayName: share.creator_display_name,
    creatorAuthType: share.creator_auth_type,
    creatorYoutubeChannelId: share.creator_youtube_channel_id || null
  });
}));

/**
 * GET /api/shares/video/:videoId
 * Browse shares for a specific video
 */
router.get('/video/:videoId', optionalAuth, asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;

  // Validate video ID
  if (!isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Invalid video ID',
      message: 'Video ID must be 11 characters (YouTube format)'
    });
  }

  // Find shares
  const shares = await Share.findByVideoId(videoId, limit, offset);

  // Batch query suggestion counts for all share tokens
  const shareTokens = shares.map(s => s.share_token);
  const userId = req.user ? req.user.id : null;
  const suggestionRows = await Report.findByShareTokens(shareTokens, userId);

  // Build lookup: { shareToken: { annotationId: { count, userHasSuggestion } } }
  const suggestionMap = {};
  for (const row of suggestionRows) {
    if (!suggestionMap[row.share_token]) suggestionMap[row.share_token] = {};
    suggestionMap[row.share_token][row.annotation_id] = {
      count: parseInt(row.suggestion_count, 10),
      userHasSuggestion: row.user_has_suggestion || false
    };
  }

  // Format response — include full annotations so client needs only one request
  const formattedShares = shares.map(share => ({
    shareToken: share.share_token,
    title: share.title,
    annotations: share.annotations,
    annotationCount: share.annotations.length,
    viewCount: share.view_count,
    createdAt: share.created_at,
    isOwner: !!(req.user && req.user.id === share.user_id),
    userId: share.user_id,
    creatorDisplayName: share.creator_display_name,
    creatorAuthType: share.creator_auth_type,
    creatorYoutubeChannelId: share.creator_youtube_channel_id || null,
    suggestionCounts: suggestionMap[share.share_token] || {}
  }));

  res.json({
    videoId,
    shares: formattedShares,
    count: formattedShares.length,
    limit,
    offset
  });
}));

/**
 * PUT /api/shares/:token
 * Update share
 * Requires authentication and ownership
 */
router.put('/:token', authenticateAnonymous, rejectBannedWrites, rateLimitCitations, asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { title, annotations, isPublic } = req.body;

  // Validate token format
  if (!isValidShareToken(token)) {
    return res.status(400).json({
      error: 'Invalid share token'
    });
  }

  // Find share
  const share = await Share.findByToken(token);

  if (!share) {
    return res.status(404).json({
      error: 'Share not found'
    });
  }

  // Check ownership
  if (share.user_id !== req.user.id) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to update this share'
    });
  }

  // Validate updates
  const updates = {};

  if (title !== undefined) {
    if (!isValidTitle(title)) {
      return res.status(400).json({
        error: 'Invalid title'
      });
    }
    updates.title = sanitizeText(title);
  }

  let addedNewCitation = false;
  if (annotations !== undefined) {
    const validation = validateAnnotations(annotations);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid annotations',
        message: validation.error
      });
    }

    // IMPORTANT: Preserve deleted annotations from database
    // Get existing deleted annotations
    const deletedAnnotations = (share.annotations || []).filter(ann => ann.deleted_at);

    // Combine incoming annotations with deleted ones
    // Deleted annotations won't be in the incoming array (frontend filters them)
    updates.annotations = [...annotations, ...deletedAnnotations];

    console.log('[Shares PUT] Preserving', deletedAnnotations.length, 'deleted annotations');

    // Check if new citations were added (compare active annotations only)
    const activeAnnotationsCount = (share.annotations || []).filter(ann => !ann.deleted_at).length;
    if (annotations.length > activeAnnotationsCount) {
      addedNewCitation = true;
    }
  }

  if (isPublic !== undefined) {
    updates.isPublic = isPublic;
  }

  // Update share
  const updatedShare = await Share.update(token, updates);

  // Increment citation count if new citations were added (async, don't wait)
  if (addedNewCitation) {
    incrementCitationCount(req.user.id, share.video_id).catch(err => {
      console.error('[Shares] Error incrementing citation count:', err);
    });
  }

  res.json({
    shareToken: updatedShare.share_token,
    videoId: updatedShare.video_id,
    title: updatedShare.title,
    annotationCount: updatedShare.annotations.length,
    isPublic: updatedShare.is_public,
    updatedAt: updatedShare.updated_at
  });
}));

/**
 * PUT /api/shares/:token/annotations/:annotationId
 * Edit a single annotation's text within a share
 * Requires authentication and ownership
 */
router.put('/:token/annotations/:annotationId', authenticateAnonymous, rejectBannedWrites, asyncHandler(async (req, res) => {
  const { token, annotationId } = req.params;
  const { text, citation } = req.body;

  // Validate token format
  if (!isValidShareToken(token)) {
    return res.status(400).json({ error: 'Invalid share token' });
  }

  // At least one of text or citation must be provided
  if (!text && !citation) {
    return res.status(400).json({ error: 'At least one of text or citation is required' });
  }

  // Validate text if provided
  if (text !== undefined) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Text must be a non-empty string' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'Text too long', message: 'Maximum 2000 characters' });
    }
  }

  // Validate citation fields if provided
  if (citation !== undefined) {
    if (typeof citation !== 'object' || citation === null || Array.isArray(citation)) {
      return res.status(400).json({ error: 'Citation must be an object' });
    }
    for (const [key, val] of Object.entries(citation)) {
      if (typeof val !== 'string') {
        return res.status(400).json({ error: `Citation field "${key}" must be a string` });
      }
      if (val.length > 500) {
        return res.status(400).json({ error: `Citation field "${key}" too long`, message: 'Maximum 500 characters' });
      }
    }
  }

  // Find share
  const share = await Share.findByToken(token);
  if (!share) {
    return res.status(404).json({ error: 'Share not found' });
  }

  // Check ownership
  if (share.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden', message: 'You can only edit your own annotations' });
  }

  // Find and update the specific annotation in the JSONB array
  const updatedAnnotations = (share.annotations || []).map(ann => {
    if (ann.id === annotationId) {
      const updated = { ...ann, editedAt: new Date().toISOString() };
      if (text !== undefined) {
        updated.text = sanitizeText(text);
      }
      if (citation !== undefined) {
        // Merge citation changes into existing citation object
        const sanitizedCitation = {};
        for (const [key, val] of Object.entries(citation)) {
          sanitizedCitation[key] = sanitizeText(val);
        }
        updated.citation = { ...(ann.citation || {}), ...sanitizedCitation };
      }
      return updated;
    }
    return ann;
  });

  // Verify annotation was found
  const found = updatedAnnotations.some(ann => ann.id === annotationId);
  if (!found) {
    return res.status(404).json({ error: 'Annotation not found' });
  }

  // Update the share
  const updatedShare = await Share.update(token, { annotations: updatedAnnotations });

  res.json({
    shareToken: updatedShare.share_token,
    annotationId,
    updatedAt: updatedShare.updated_at
  });
}));

/**
 * DELETE /api/shares/:token
 * Delete share
 * Requires authentication and ownership
 */
router.delete('/:token', authenticateAnonymous, rejectBannedWrites, asyncHandler(async (req, res) => {
  const { token } = req.params;

  // Validate token format
  if (!isValidShareToken(token)) {
    return res.status(400).json({
      error: 'Invalid share token'
    });
  }

  // Find share
  const share = await Share.findByToken(token);

  if (!share) {
    return res.status(404).json({
      error: 'Share not found'
    });
  }

  // Check ownership
  if (share.user_id !== req.user.id) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to delete this share'
    });
  }

  // Delete share
  await Share.delete(token);

  res.json({
    message: 'Share deleted successfully',
    shareToken: token
  });
}));

/**
 * GET /api/shares/admin/rate-limit/:userId
 * Get rate limit statistics for a user (admin/debug endpoint)
 */
router.get('/admin/rate-limit/:userId', asyncHandler(getRateLimitStats));

module.exports = router;
