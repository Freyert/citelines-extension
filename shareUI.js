/**
 * YouTube Annotator Share UI Components
 * Handles UI for sharing and importing annotations
 */

/**
 * Escape a string for safe insertion into innerHTML.
 *
 * Template literals interpolated directly into innerHTML are an XSS sink:
 * if user-controlled content contains HTML tags or event-handler attributes
 * (e.g. <img src=x onerror="...">) they will be parsed and executed by the
 * browser. This is particularly dangerous in a content script context where
 * executing code has access to chrome.storage and the extension's auth token.
 *
 * Using the browser's own text node serialisation (textContent → innerHTML)
 * is preferred over a regex or manual replacement because it correctly handles
 * all HTML entities without the risk of an incomplete escape list.
 *
 * @param {*} str - Value to escape (non-strings are coerced; null/undefined → '')
 * @returns {string} HTML-escaped string safe for use inside an innerHTML template
 */
function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * Create share button
 * @returns {HTMLElement} Share button
 */
function createShareButton() {
  const button = document.createElement('button');
  button.id = 'annotator-share-btn';
  button.className = 'annotator-control-btn';
  button.textContent = 'Share';
  button.title = 'Share your annotations';
  button.style.cssText = `
    background: #2196F3;
    color: white;
    border: none;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    margin-left: 8px;
    font-family: "Roboto", "Arial", sans-serif;
  `;

  button.addEventListener('mouseenter', () => {
    button.style.background = '#1976D2';
  });

  button.addEventListener('mouseleave', () => {
    button.style.background = '#2196F3';
  });

  return button;
}

/**
 * Create browse shares button
 * @returns {HTMLElement} Browse button
 */
function createBrowseButton() {
  const button = document.createElement('button');
  button.id = 'annotator-browse-btn';
  button.className = 'annotator-control-btn';
  button.textContent = 'Browse';
  button.title = 'Browse shared annotations for this video';
  button.style.cssText = `
    background: #4CAF50;
    color: white;
    border: none;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    margin-left: 8px;
    font-family: "Roboto", "Arial", sans-serif;
  `;

  button.addEventListener('mouseenter', () => {
    button.style.background = '#45a049';
  });

  button.addEventListener('mouseleave', () => {
    button.style.background = '#4CAF50';
  });

  return button;
}

/**
 * Show share modal
 * @param {string} videoId - YouTube video ID
 * @param {Array} annotations - Annotations to share
 * @param {string} videoTitle - Video title
 * @param {Function} onShare - Callback when share is created
 */
async function showShareModal(videoId, annotations, videoTitle, onShare) {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'annotator-share-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    font-family: "Roboto", "Arial", sans-serif;
  `;

  // Create modal
  const modal = document.createElement('div');
  modal.style.cssText = `
    background: white;
    border-radius: 8px;
    padding: 24px;
    max-width: 500px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `;

  // Modal content
  modal.innerHTML = `
    <h2 style="margin: 0 0 16px 0; color: #202124; font-size: 20px;">Share Annotations</h2>

    <div style="margin-bottom: 16px; color: #5f6368; font-size: 14px;">
      <div style="margin-bottom: 8px;">
        <strong>Video:</strong> ${escapeHtml(videoTitle)}
      </div>
      <div>
        <strong>Annotations:</strong> ${annotations.length}
      </div>
    </div>

    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 8px; color: #202124; font-size: 14px;">
        Share Title (optional)
      </label>
      <input
        type="text"
        id="share-title-input"
        placeholder="e.g., Great insights on quantum physics"
        maxlength="255"
        style="width: 100%; padding: 8px; border: 1px solid #dadce0; border-radius: 4px; font-size: 14px; box-sizing: border-box;"
      />
    </div>

    <div id="share-result" style="display: none; margin-bottom: 16px;"></div>

    <div style="display: flex; justify-content: flex-end; gap: 8px;">
      <button id="share-cancel-btn" style="
        background: #f8f9fa;
        color: #202124;
        border: 1px solid #dadce0;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      ">Cancel</button>
      <button id="share-create-btn" style="
        background: #2196F3;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      ">Create Share</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Event handlers
  const titleInput = modal.querySelector('#share-title-input');
  const cancelBtn = modal.querySelector('#share-cancel-btn');
  const createBtn = modal.querySelector('#share-create-btn');
  const resultDiv = modal.querySelector('#share-result');

  const closeModal = () => {
    overlay.remove();
  };

  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  createBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim() || null;

    // Disable button during request
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    createBtn.style.opacity = '0.6';

    try {
      const result = await api.createShare(videoId, annotations, title);

      // Show success message
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `
        <div style="background: #e8f5e9; border: 1px solid #4caf50; border-radius: 4px; padding: 12px;">
          <div style="color: #2e7d32; font-size: 14px; margin-bottom: 8px;">
            ✓ Share created successfully!
          </div>
          <div style="background: white; padding: 8px; border-radius: 4px; word-break: break-all; font-size: 13px; font-family: monospace;">
            ${escapeHtml(result.shareUrl)}
          </div>
          <button id="copy-link-btn" style="
            background: #4CAF50;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            margin-top: 8px;
            width: 100%;
          ">Copy Link</button>
        </div>
      `;

      // Copy button handler
      const copyBtn = resultDiv.querySelector('#copy-link-btn');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(result.shareUrl);
        copyBtn.textContent = '✓ Copied!';
        copyBtn.style.background = '#388E3C';
        setTimeout(() => {
          closeModal();
        }, 1000);
      });

      // Update button state
      createBtn.style.display = 'none';
      cancelBtn.textContent = 'Close';

      // Call callback
      if (onShare) {
        onShare(result);
      }
    } catch (error) {
      console.error('Failed to create share:', error);

      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `
        <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828; font-size: 14px;">
          ✗ Failed to create share: ${escapeHtml(error.message)}
        </div>
      `;

      createBtn.disabled = false;
      createBtn.textContent = 'Create Share';
      createBtn.style.opacity = '1';
    }
  });
}

/**
 * Show import modal for shared annotations
 * @param {Object} shareData - Share data from API
 * @param {Array} localAnnotations - Current local annotations
 * @param {Function} onImport - Callback with import choice (merge, replace, view)
 */
function showImportModal(shareData, localAnnotations, onImport) {
  const overlay = document.createElement('div');
  overlay.id = 'annotator-import-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    font-family: "Roboto", "Arial", sans-serif;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: white;
    border-radius: 8px;
    padding: 24px;
    max-width: 600px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `;

  // Format annotations preview
  const annotationsPreview = shareData.annotations.slice(0, 5).map(ann => {
    const time = formatTime(ann.timestamp);
    const text = ann.text.length > 100 ? ann.text.substring(0, 100) + '...' : ann.text;
    return `<div style="padding: 8px; background: #f8f9fa; border-radius: 4px; margin-bottom: 8px;">
      <strong style="color: #1976D2;">${time}</strong> - ${escapeHtml(text)}
    </div>`;
  }).join('');

  const moreAnnotations = shareData.annotations.length > 5
    ? `<div style="color: #5f6368; font-size: 13px; margin-top: 8px;">... and ${shareData.annotations.length - 5} more</div>`
    : '';

  modal.innerHTML = `
    <h2 style="margin: 0 0 16px 0; color: #202124; font-size: 20px;">Import Shared Annotations</h2>

    <div style="margin-bottom: 16px;">
      ${shareData.title ? `<div style="color: #5f6368; font-size: 14px; margin-bottom: 8px;"><strong>Title:</strong> ${escapeHtml(shareData.title)}</div>` : ''}
      <div style="color: #5f6368; font-size: 14px; margin-bottom: 8px;">
        <strong>Shared annotations:</strong> ${shareData.annotations.length}
      </div>
      <div style="color: #5f6368; font-size: 14px; margin-bottom: 16px;">
        <strong>Your local annotations:</strong> ${localAnnotations.length}
      </div>
    </div>

    <div style="margin-bottom: 16px;">
      <div style="font-size: 14px; color: #202124; margin-bottom: 8px; font-weight: 500;">Preview:</div>
      ${annotationsPreview}
      ${moreAnnotations}
    </div>

    <div style="margin-bottom: 16px; padding: 12px; background: #e3f2fd; border-radius: 4px; color: #1565c0; font-size: 13px;">
      Choose how to handle these annotations:
    </div>

    <div style="display: grid; gap: 8px; margin-bottom: 16px;">
      <button id="import-view-btn" style="
        background: #f8f9fa;
        color: #202124;
        border: 1px solid #dadce0;
        padding: 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        text-align: left;
      ">
        <strong>View Only</strong><br>
        <span style="font-size: 12px; color: #5f6368;">Display shared annotations without saving (different color)</span>
      </button>

      <button id="import-merge-btn" style="
        background: #f8f9fa;
        color: #202124;
        border: 1px solid #dadce0;
        padding: 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        text-align: left;
      ">
        <strong>Merge with Mine</strong><br>
        <span style="font-size: 12px; color: #5f6368;">Combine shared annotations with your local ones</span>
      </button>

      <button id="import-replace-btn" style="
        background: #f8f9fa;
        color: #202124;
        border: 1px solid #dadce0;
        padding: 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        text-align: left;
      ">
        <strong>Replace Mine</strong><br>
        <span style="font-size: 12px; color: #5f6368;">Overwrite your local annotations with these</span>
      </button>

      <button id="import-cancel-btn" style="
        background: white;
        color: #202124;
        border: 1px solid #dadce0;
        padding: 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      ">Cancel</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const closeModal = () => {
    overlay.remove();
  };

  // Event handlers
  modal.querySelector('#import-view-btn').addEventListener('click', () => {
    onImport('view', shareData.annotations);
    closeModal();
  });

  modal.querySelector('#import-merge-btn').addEventListener('click', () => {
    onImport('merge', shareData.annotations);
    closeModal();
  });

  modal.querySelector('#import-replace-btn').addEventListener('click', () => {
    onImport('replace', shareData.annotations);
    closeModal();
  });

  modal.querySelector('#import-cancel-btn').addEventListener('click', closeModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Show browse shares modal
 * @param {string} videoId - YouTube video ID
 * @param {Function} onSelectShare - Callback when share is selected
 */
async function showBrowseModal(videoId, onSelectShare) {
  const overlay = document.createElement('div');
  overlay.id = 'annotator-browse-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    font-family: "Roboto", "Arial", sans-serif;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: white;
    border-radius: 8px;
    padding: 24px;
    max-width: 700px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `;

  modal.innerHTML = `
    <h2 style="margin: 0 0 16px 0; color: #202124; font-size: 20px;">Browse Shared Annotations</h2>
    <div id="browse-content" style="min-height: 200px;">
      <div style="text-align: center; padding: 40px; color: #5f6368;">
        Loading...
      </div>
    </div>
    <div style="margin-top: 16px; text-align: right;">
      <button id="browse-close-btn" style="
        background: #f8f9fa;
        color: #202124;
        border: 1px solid #dadce0;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      ">Close</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const closeModal = () => {
    overlay.remove();
  };

  modal.querySelector('#browse-close-btn').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Load shares
  try {
    const result = await api.getSharesForVideo(videoId);
    const contentDiv = modal.querySelector('#browse-content');

    if (result.shares.length === 0) {
      contentDiv.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #5f6368;">
          No shared annotations found for this video yet.<br>
          Be the first to share!
        </div>
      `;
      return;
    }

    contentDiv.innerHTML = result.shares.map((share, index) => `
      <div class="browse-share-item" data-token="${share.shareToken}" style="
        padding: 16px;
        background: #f8f9fa;
        border-radius: 4px;
        margin-bottom: 12px;
        cursor: pointer;
        border: 2px solid transparent;
        transition: border-color 0.2s;
      ">
        <div style="font-weight: 500; color: #202124; margin-bottom: 4px;">
          ${escapeHtml(share.title) || `Share #${index + 1}`}
        </div>
        <div style="font-size: 13px; color: #5f6368;">
          ${share.annotationCount} annotations • ${share.viewCount} views
        </div>
        <div style="font-size: 12px; color: #5f6368; margin-top: 4px;">
          ${new Date(share.createdAt).toLocaleDateString()}
        </div>
      </div>
    `).join('');

    // Add click handlers
    contentDiv.querySelectorAll('.browse-share-item').forEach(item => {
      item.addEventListener('mouseenter', () => {
        item.style.borderColor = '#2196F3';
      });
      item.addEventListener('mouseleave', () => {
        item.style.borderColor = 'transparent';
      });
      item.addEventListener('click', async () => {
        const token = item.getAttribute('data-token');
        try {
          const shareData = await api.getShare(token);
          closeModal();
          onSelectShare(shareData);
        } catch (error) {
          console.error('Failed to load share:', error);
          alert('Failed to load share: ' + error.message);
        }
      });
    });
  } catch (error) {
    console.error('Failed to load shares:', error);
    modal.querySelector('#browse-content').innerHTML = `
      <div style="text-align: center; padding: 40px; color: #d32f2f;">
        Failed to load shares: ${escapeHtml(error.message)}
      </div>
    `;
  }
}

/**
 * Format seconds to MM:SS
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
window.createShareButton = createShareButton;
window.createBrowseButton = createBrowseButton;
window.showShareModal = showShareModal;
window.showImportModal = showImportModal;
window.showBrowseModal = showBrowseModal;
