let settings = null;
let observer = null;
let lastUserGestureAt = 0;
let reportTimer = null;
let watchersInstalled = false;
let mediaLoopTimer = null;

const pageStats = {
  imagesBlocked: 0,
  videosPaused: 0,
  estimatedSavedBytes: 0
};

const DATA_KEYS = {
  originalSrc: 'baqtyOriginalSrc',
  processed: 'baqtyProcessed',
  videoProcessed: 'baqtyVideoProcessed',
  userAllowed: 'baqtyUserAllowed',
  overlay: 'baqtyOverlay',
  imageOverlay: 'baqtyImageOverlay',
  imageRestored: 'baqtyImageRestored'
};

const HOST = location.hostname.replace(/^www\./, '');
const IS_FACEBOOK = /(^|\.)facebook\.com$/.test(HOST);
const IS_YOUTUBE = /(^|\.)youtube\.com$/.test(HOST) || /(^|\.)youtu\.be$/.test(HOST);

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => resolve(response));
    } catch (error) {
      resolve({ ok: false, error: String(error) });
    }
  });
}

async function loadSettings() {
  const response = await sendMessage({ type: 'GET_SETTINGS' });
  settings = response || { enabled: false };
  return settings;
}

function isActive() {
  return settings && settings.enabled;
}

function now() {
  return Date.now();
}

function hadRecentGesture() {
  return now() - lastUserGestureAt < 1800;
}

function markGesture() {
  lastUserGestureAt = now();
}

['pointerdown', 'mousedown', 'touchstart', 'keydown'].forEach((type) => {
  window.addEventListener(type, markGesture, true);
});

function estimateImageBytes(img) {
  const w = Number(img.getAttribute('width')) || img.naturalWidth || img.clientWidth || 600;
  const h = Number(img.getAttribute('height')) || img.naturalHeight || img.clientHeight || 400;
  const pixels = Math.max(1, w * h);
  return Math.min(2 * 1024 * 1024, Math.max(40 * 1024, Math.round(pixels * 0.35)));
}

function transparentPixel() {
  return 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
}

function shouldBlockImages() {
  return isActive() && (settings.mode === 'extreme' || settings.blockImages);
}

function shouldPauseVideos() {
  return isActive() && settings.pauseVideos !== false;
}

function shouldGuardFacebookReels(video) {
  if (!isActive() || !settings.facebookReelsGuard || !IS_FACEBOOK || !video) return false;
  const src = video.currentSrc || video.src || '';
  const url = location.href.toLowerCase();
  const inReelsArea = Boolean(video.closest('[role="dialog"], [data-pagelet*="Reels"], [aria-label*="Reels"], [aria-label*="ريلز"]'));
  return src.startsWith('blob:') || url.includes('/reel') || url.includes('/watch') || inReelsArea || video.muted;
}

function shouldGuardYouTube(video) {
  if (!isActive() || !settings.youtubeControls || !IS_YOUTUBE || !video) return false;
  const url = location.href.toLowerCase();
  const isShort = url.includes('/shorts/') || video.closest('ytd-reel-video-renderer, ytd-shorts, ytd-rich-grid-slim-media');
  if (settings.youtubePauseShorts && isShort) return true;
  return settings.youtubeDisablePreviews && (video.muted || video.closest('ytd-thumbnail, ytd-rich-item-renderer, ytd-video-preview, ytd-inline-preview-player-renderer'));
}

function shouldHardStop(video) {
  return shouldGuardFacebookReels(video) || shouldGuardYouTube(video);
}

function addVideoOverlay(video, label) {
  if (!video || video.dataset[DATA_KEYS.overlay] === '1') return;
  const parent = video.parentElement;
  if (!parent) return;

  const computed = getComputedStyle(parent);
  if (computed.position === 'static') parent.style.position = 'relative';

  const overlay = document.createElement('button');
  overlay.type = 'button';
  overlay.className = 'baqty-video-overlay';
  overlay.textContent = label || 'وفر باقتك: الفيديو متوقف. اضغط للتشغيل';
  overlay.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    video.dataset[DATA_KEYS.userAllowed] = '1';
    video.dataset[DATA_KEYS.videoProcessed] = '1';
    video.preload = 'metadata';
    video.autoplay = false;
    try { video.muted = false; } catch (_) {}
    overlay.remove();
    video.dataset[DATA_KEYS.overlay] = '0';
    video.play().catch(() => {});
  }, true);

  video.dataset[DATA_KEYS.overlay] = '1';
  parent.appendChild(overlay);
}

function stopVideo(video, reason = 'auto') {
  if (!video || video.dataset[DATA_KEYS.userAllowed] === '1') return;

  try { video.autoplay = false; } catch (_) {}
  try { video.preload = 'none'; } catch (_) {}
  try { video.pause(); } catch (_) {}
  try { video.removeAttribute('autoplay'); } catch (_) {}

  if (reason === 'facebook') {
    addVideoOverlay(video, 'وفر باقتك: Facebook Reels/Blob متوقف. اضغط للتشغيل');
  } else if (reason === 'youtube') {
    addVideoOverlay(video, 'وضع يوتيوب الاقتصادي: اضغط لتشغيل الفيديو');
  } else {
    addVideoOverlay(video, 'وفر باقتك: الفيديو متوقف. اضغط للتشغيل');
  }
}

function pauseVideo(video) {
  if (!shouldPauseVideos() || !video) return;
  if (video.dataset[DATA_KEYS.userAllowed] === '1') return;

  const specialFacebook = shouldGuardFacebookReels(video);
  const specialYouTube = shouldGuardYouTube(video);
  const genericAutoplay = video.autoplay || video.muted || settings.mode !== 'light';

  if (!specialFacebook && !specialYouTube && video.dataset[DATA_KEYS.videoProcessed] === '1') return;
  if (!specialFacebook && !specialYouTube && hadRecentGesture()) return;
  if (!specialFacebook && !specialYouTube && !genericAutoplay) return;

  video.dataset[DATA_KEYS.videoProcessed] = '1';
  stopVideo(video, specialFacebook ? 'facebook' : specialYouTube ? 'youtube' : 'auto');

  pageStats.videosPaused += 1;
  pageStats.estimatedSavedBytes += specialYouTube || specialFacebook ? 5 * 1024 * 1024 : 3 * 1024 * 1024;
}


function getImageKey(img) {
  return img.currentSrc || img.src || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || '';
}

function preserveLazyImageAttrs(img) {
  ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url'].forEach((attr) => {
    const value = img.getAttribute(attr);
    if (value && !img.dataset[`baqtyOriginal_${attr}`]) img.dataset[`baqtyOriginal_${attr}`] = value;
  });
}

function clearLazyImageAttrs(img) {
  ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url'].forEach((attr) => {
    if (img.hasAttribute(attr)) img.removeAttribute(attr);
  });
}

function getPausedImageSize(img) {
  const rect = img.getBoundingClientRect?.() || { width: 0, height: 0 };
  const attrW = parseInt(img.getAttribute('width') || '', 10);
  const attrH = parseInt(img.getAttribute('height') || '', 10);
  const width = Math.round(rect.width || img.clientWidth || attrW || 180);
  const height = Math.round(rect.height || img.clientHeight || attrH || 110);
  return {
    width: Math.max(80, Math.min(width, 820)),
    height: Math.max(56, Math.min(height, 520))
  };
}

function createImagePlaceholder(img, restore) {
  const { width, height } = getPausedImageSize(img);

  // Tiny icons, avatars and UI sprites should not get a text card; they restore on hover/click only.
  if (width < 96 || height < 64) return null;

  const token = `baqty-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const placeholder = document.createElement('button');
  placeholder.type = 'button';
  placeholder.className = 'baqty-image-placeholder';
  placeholder.dataset.baqtyPlaceholderFor = token;
  placeholder.setAttribute('aria-label', 'انقر لعرض الصورة');
  placeholder.style.width = `${width}px`;
  placeholder.style.height = `${height}px`;
  placeholder.innerHTML = '<span class="baqty-image-icon" aria-hidden="true"></span><strong>انقر لعرض الصورة</strong><small>أو مرّر الماوس فوقها</small>';

  const restoreFromPlaceholder = (event) => {
    event.preventDefault();
    event.stopPropagation();
    restore();
  };
  placeholder.addEventListener('click', restoreFromPlaceholder, true);
  placeholder.addEventListener('pointerenter', restoreFromPlaceholder, { once: true, capture: true });
  placeholder.addEventListener('mouseenter', restoreFromPlaceholder, { once: true, capture: true });

  const picture = img.closest('picture');
  const hiddenNode = picture || img;
  img.dataset.baqtyPlaceholderId = token;
  img.dataset.baqtyHiddenNodeDisplay = hiddenNode.style.display || '';

  hiddenNode.style.display = 'none';
  hiddenNode.insertAdjacentElement('afterend', placeholder);
  return placeholder;
}

function installImageInteraction(img, restore) {
  if (!img || img.dataset[DATA_KEYS.imageOverlay] === '1') return;
  img.dataset[DATA_KEYS.imageOverlay] = '1';

  const restoreOnHover = () => restore();
  const restoreOnClick = (event) => {
    if (img.dataset[DATA_KEYS.imageRestored] === '1') return;
    // First click restores the image instead of opening/navigating while it is still paused.
    event.preventDefault();
    event.stopPropagation();
    restore();
  };

  const placeholder = createImagePlaceholder(img, restore);

  // If no placeholder was created (small icon/avatar), the original image area still restores on hover/click.
  img.addEventListener('pointerenter', restoreOnHover, { once: true, capture: true });
  img.addEventListener('mouseenter', restoreOnHover, { once: true, capture: true });
  img.addEventListener('focus', restoreOnHover, { once: true, capture: true });
  img.addEventListener('click', restoreOnClick, { capture: true });

  // Keep wrapper hover narrow: links/picture/figure only, never broad div containers.
  if (!placeholder) {
    const wrapper = img.closest('a, picture, figure, [role="button"]');
    if (wrapper && wrapper !== img) {
      wrapper.addEventListener('pointerenter', restoreOnHover, { once: true, capture: true });
      wrapper.addEventListener('mouseenter', restoreOnHover, { once: true, capture: true });
    }
  }
}

function restoreImage(img) {
  if (!img || img.dataset[DATA_KEYS.imageRestored] === '1') return;
  img.dataset[DATA_KEYS.imageRestored] = '1';

  const originalSrc = img.dataset[DATA_KEYS.originalSrc];
  const originalSrcset = img.dataset.baqtyOriginalSrcset;
  const originalSizes = img.dataset.baqtyOriginalSizes;

  if (originalSizes) img.setAttribute('sizes', originalSizes);
  if (originalSrcset) img.setAttribute('srcset', originalSrcset);
  if (originalSrc) img.src = originalSrc;

  ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url'].forEach((attr) => {
    const stored = img.dataset[`baqtyOriginal_${attr}`];
    if (stored) img.setAttribute(attr, stored);
  });

  img.classList.remove('baqty-image-paused');
  img.title = '';

  const picture = img.closest('picture');
  const hiddenNode = picture || img;
  if (img.dataset.baqtyHiddenNodeDisplay !== undefined) {
    hiddenNode.style.display = img.dataset.baqtyHiddenNodeDisplay || '';
    delete img.dataset.baqtyHiddenNodeDisplay;
  }

  img.closest('picture')?.querySelectorAll('source').forEach((source) => {
    const original = source.dataset.baqtyOriginalSrcset;
    if (original) source.setAttribute('srcset', original);
  });

  const token = img.dataset.baqtyPlaceholderId;
  if (token) {
    document.querySelectorAll(`[data-baqty-placeholder-for="${token}"]`).forEach((node) => node.remove());
    delete img.dataset.baqtyPlaceholderId;
  }
  img.parentElement?.querySelectorAll(':scope > .baqty-image-overlay').forEach((node) => node.remove());
}

function blockImage(img) {
  if (!shouldBlockImages()) return;
  if (!img || img.dataset[DATA_KEYS.processed] === '1' || img.dataset[DATA_KEYS.imageRestored] === '1') return;
  if (img.src && (img.src.startsWith('chrome-extension://') || img.src.startsWith('data:'))) return;

  const src = getImageKey(img);
  const srcset = img.getAttribute('srcset') || '';
  const sizes = img.getAttribute('sizes') || '';
  if (!src && !srcset) return;

  img.dataset[DATA_KEYS.processed] = '1';
  img.dataset[DATA_KEYS.originalSrc] = src;
  if (srcset) img.dataset.baqtyOriginalSrcset = srcset;
  if (sizes) img.dataset.baqtyOriginalSizes = sizes;
  preserveLazyImageAttrs(img);

  const savedBytes = estimateImageBytes(img);
  pageStats.imagesBlocked += 1;
  pageStats.estimatedSavedBytes += savedBytes;

  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  clearLazyImageAttrs(img);
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = transparentPixel();
  img.classList.add('baqty-image-paused');
  img.title = 'وفر باقتك: اضغط لتحميل الصورة';

  const restore = () => restoreImage(img);
  img.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') restore();
  }, { once: true, capture: true });
  installImageInteraction(img, restore);
}

function controlMediaElement(video) {
  if (!video || video.__baqtyListenersInstalled) return;
  video.__baqtyListenersInstalled = true;

  video.addEventListener('play', () => {
    if (!isActive() || video.dataset[DATA_KEYS.userAllowed] === '1') return;
    if (shouldHardStop(video) || (!hadRecentGesture() && shouldPauseVideos() && (video.autoplay || video.muted))) {
      setTimeout(() => pauseVideo(video), 0);
    }
  }, true);

  video.addEventListener('loadedmetadata', () => {
    if (shouldHardStop(video)) pauseVideo(video);
  }, true);
}

function removeLazyHeavyAttrs(root = document) {
  if (!isActive()) return;
  root.querySelectorAll?.('video, audio, source').forEach((node) => {
    if ('preload' in node) node.preload = 'none';
    if (node.tagName === 'VIDEO') controlMediaElement(node);
  });
}

function tuneYouTubePage() {
  if (!isActive() || !settings.youtubeControls || !IS_YOUTUBE) return;

  document.documentElement.classList.toggle('baqty-youtube-no-previews', Boolean(settings.youtubeDisablePreviews));

  const video = document.querySelector('video.html5-main-video, video');
  if (video) {
    controlMediaElement(video);
    if (settings.youtubePauseShorts && location.pathname.startsWith('/shorts/')) pauseVideo(video);
    if (settings.youtubeForceLowData) {
      try { video.preload = 'none'; } catch (_) {}
      try { video.autoplay = false; } catch (_) {}
    }
  }

  const autoNavButton = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"], button[aria-label*="Autoplay"][aria-pressed="true"], button[aria-label*="التشغيل التلقائي"][aria-pressed="true"]');
  if (autoNavButton && !hadRecentGesture()) {
    try { autoNavButton.click(); } catch (_) {}
  }

  try {
    localStorage.setItem('yt-player-quality', JSON.stringify({ data: 'small', expiration: Date.now() + 31536000000, creation: Date.now() }));
  } catch (_) {}

  if (settings.youtubeDisablePreviews) {
    document.querySelectorAll('ytd-video-preview, ytd-inline-preview-player-renderer video, ytd-thumbnail video').forEach((node) => {
      if (node.tagName === 'VIDEO') pauseVideo(node);
      else node.remove();
    });
  }
}

function processDocument(root = document) {
  if (!isActive()) return;

  if (shouldBlockImages()) {
    root.querySelectorAll?.('img').forEach(blockImage);
    root.querySelectorAll?.('picture source').forEach((source) => {
      if (source.dataset.baqtyProcessed === '1') return;
      source.dataset.baqtyProcessed = '1';
      if (source.srcset) {
        source.dataset.baqtyOriginalSrcset = source.srcset;
        source.removeAttribute('srcset');
      }
    });
  }

  root.querySelectorAll?.('video').forEach((video) => {
    controlMediaElement(video);
    pauseVideo(video);
  });

  removeLazyHeavyAttrs(root);
  tuneYouTubePage();
}

function addBadge() {
  if (!settings?.showBadges || !isActive() || document.getElementById('baqty-badge')) return;
  const badge = document.createElement('div');
  badge.id = 'baqty-badge';
  badge.className = 'baqty-badge';
  badge.textContent = IS_YOUTUBE ? 'يوتيوب اقتصادي شغال' : IS_FACEBOOK ? 'حماية الريلز شغالة' : 'وفر باقتك شغال';
  document.documentElement.appendChild(badge);
  setTimeout(() => badge.remove(), 3500);
}

function reportStatsSoon() {
  const report = () => {
    if (pageStats.imagesBlocked || pageStats.videosPaused || pageStats.estimatedSavedBytes) {
      sendMessage({
        type: 'ADD_STATS',
        payload: {
          imagesBlocked: pageStats.imagesBlocked,
          videosPaused: pageStats.videosPaused,
          estimatedSavedBytes: pageStats.estimatedSavedBytes,
          requestsBlocked: pageStats.imagesBlocked + pageStats.videosPaused
        }
      });
      pageStats.imagesBlocked = 0;
      pageStats.videosPaused = 0;
      pageStats.estimatedSavedBytes = 0;
    }
  };
  window.addEventListener('pagehide', report, { once: true });
  reportTimer = setInterval(report, 15000);
}

function installMutationObserver() {
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target?.tagName === 'IMG') {
        const img = mutation.target;
        if (shouldBlockImages() && img.dataset[DATA_KEYS.imageRestored] !== '1') {
          img.dataset[DATA_KEYS.processed] = '0';
          blockImage(img);
        }
      }
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.tagName === 'IMG') blockImage(node);
        if (node.tagName === 'VIDEO') {
          controlMediaElement(node);
          pauseVideo(node);
        }
        processDocument(node);
      });
    }
  });
  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'sizes', 'data-src', 'data-original', 'data-lazy-src']
  });
}

function watchUrlChanges() {
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) {
      last = location.href;
      setTimeout(() => processDocument(document), 350);
      setTimeout(() => processDocument(document), 1200);
    }
  }, 600);
}


function removeBadge() {
  document.getElementById('baqty-badge')?.remove();
}

function setGlobalClasses() {
  document.documentElement.classList.toggle(
    'baqty-youtube-no-previews',
    Boolean(settings?.enabled && settings?.youtubeControls && settings?.youtubeDisablePreviews && IS_YOUTUBE)
  );
}


function installAggressiveMediaLoop() {
  if (mediaLoopTimer) return;
  mediaLoopTimer = setInterval(() => {
    if (!isActive()) return;
    if (!(IS_YOUTUBE || IS_FACEBOOK || settings.pauseVideos)) return;
    document.querySelectorAll('video').forEach((video) => {
      if (shouldHardStop(video)) {
        pauseVideo(video);
        return;
      }
      if ((IS_YOUTUBE || IS_FACEBOOK) && settings.pauseVideos && video.dataset[DATA_KEYS.userAllowed] !== '1' && !hadRecentGesture()) {
        const src = video.currentSrc || video.src || '';
        if (video.muted || src.startsWith('blob:') || video.autoplay) pauseVideo(video);
      }
    });
    if (IS_YOUTUBE) tuneYouTubePage();
  }, 700);
}

function ensureBrowserWideWatchers() {
  if (watchersInstalled) return;
  watchersInstalled = true;
  installMutationObserver();
  reportStatsSoon();
  watchUrlChanges();
  installAggressiveMediaLoop();
  document.addEventListener('DOMContentLoaded', () => processDocument(document), { once: true });
}

async function applySettings(nextSettings) {
  if (nextSettings) settings = nextSettings;
  else await loadSettings();

  setGlobalClasses();

  if (!isActive()) {
    removeBadge();
    return;
  }

  addBadge();
  ensureBrowserWideWatchers();
  processDocument(document);
  setTimeout(() => processDocument(document), 500);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (!keys.some((key) => key in (settings || {}))) return;
  applySettings();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'SETTINGS_UPDATED') {
    applySettings(message.settings).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

// Keep the controller active inside long-lived tabs and single-page apps even when the popup is closed.
// This is the part that makes the protection feel always-on at page level.
['pageshow', 'focus', 'visibilitychange', 'online', 'resume'].forEach((eventName) => {
  window.addEventListener(eventName, () => {
    if (document.visibilityState === 'hidden' && eventName !== 'visibilitychange') return;
    applySettings().catch(() => {});
  }, true);
});

setInterval(() => {
  if (!settings?.enabled) return;
  processDocument(document);
}, 5000);

(async function boot() {
  await loadSettings();
  await applySettings(settings);
})();
