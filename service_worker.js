const DEFAULT_SETTINGS = {
  enabled: true,
  mode: 'medium', // light | medium | extreme
  blockFonts: true,
  blockMedia: true,
  blockImages: false,
  blockTrackers: true,
  pauseVideos: true,
  showBadges: true,
  facebookReelsGuard: true,
  youtubeControls: true,
  youtubePauseShorts: true,
  youtubeDisablePreviews: true,
  youtubeForceLowData: true,
  siteOverrides: {},
  stats: {
    requestsBlocked: 0,
    imagesBlocked: 0,
    videosPaused: 0,
    estimatedSavedBytes: 0,
    updatedAt: Date.now()
  }
};

const MODE_RULE_IDS = [1001, 1002, 1003, 1004, 1005, 1006];

const VIDEO_SITE_INITIATORS = [
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'facebook.com', 'www.facebook.com', 'web.facebook.com', 'm.facebook.com'
];

const ESTIMATES = {
  image: 220 * 1024,
  media: 3 * 1024 * 1024,
  font: 70 * 1024,
  tracker: 45 * 1024
};

const KEEP_ALIVE_ALARM = 'baqty-background-health-check';
const KEEP_ALIVE_PERIOD_MINUTES = 1;
let lastSyncAt = 0;
let syncInFlight = null;

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    stats: { ...DEFAULT_SETTINGS.stats, ...(stored.stats || {}) },
    siteOverrides: stored.siteOverrides || {}
  };
}

async function saveSettings(partial) {
  const current = await getSettings();
  await chrome.storage.local.set({ ...current, ...partial });
}

function buildRules(settings) {
  if (!settings.enabled) return [];

  const shouldBlockMedia = settings.blockMedia || settings.mode === 'medium' || settings.mode === 'extreme';
  const shouldBlockFonts = settings.blockFonts || settings.mode === 'medium' || settings.mode === 'extreme';
  const shouldBlockImages = settings.blockImages || settings.mode === 'extreme';

  const rules = [];

  if (shouldBlockMedia) {
    const condition = {
      urlFilter: '|http',
      resourceTypes: ['media']
    };

    // Keep YouTube/Facebook controllable by the content script instead of breaking playback completely.
    if (settings.youtubeControls || settings.facebookReelsGuard) {
      condition.excludedInitiatorDomains = VIDEO_SITE_INITIATORS;
    }

    rules.push({
      id: 1001,
      priority: 10,
      action: { type: 'block' },
      condition
    });
  }

  if (shouldBlockFonts) {
    rules.push({
      id: 1002,
      priority: 8,
      action: { type: 'block' },
      condition: {
        urlFilter: '|http',
        resourceTypes: ['font']
      }
    });
  }

  // Images are intentionally NOT blocked with declarativeNetRequest.
  // The content script replaces them with click-to-load placeholders so the user can reveal each image on interaction.
  void shouldBlockImages;

  if (settings.mode !== 'light') {
    rules.push({
      id: 1004,
      priority: 6,
      action: { type: 'block' },
      condition: {
        regexFilter: 'https?://([^/]+\\.)?(vimeo|dailymotion)\\.com/(embed|player|video)',
        resourceTypes: ['sub_frame', 'script', 'xmlhttprequest', 'media']
      }
    });
  }


  return rules;
}


async function broadcastSettings(settings) {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.allSettled(tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings });
      } catch (_) {
        // Static content scripts load automatically on normal pages. If a tab was already open
        // before install/reload, try to inject the controller so the protection starts there too.
        try {
          await chrome.scripting?.executeScript?.({ target: { tabId: tab.id, allFrames: true }, files: ['content_script.js'] });
          await chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings });
        } catch (_) {}
      }
    }));
  } catch (_) {}
}

function ensureKeepAliveAlarm() {
  try {
    chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: KEEP_ALIVE_PERIOD_MINUTES });
  } catch (_) {}
}

async function syncNetworkRules() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const settings = await getSettings();
    const rules = buildRules(settings);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: MODE_RULE_IDS,
      addRules: rules
    });

    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: settings.enabled && settings.blockTrackers ? ['baqty_base_blocklist'] : [],
      disableRulesetIds: !settings.enabled || !settings.blockTrackers ? ['baqty_base_blocklist'] : []
    });

    lastSyncAt = Date.now();
    return settings;
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

async function wakeAndApply({ broadcast = false } = {}) {
  ensureKeepAliveAlarm();
  const settings = await syncNetworkRules();
  if (broadcast) await broadcastSettings(settings);
  return settings;
}

async function addStats(delta = {}) {
  const settings = await getSettings();
  const stats = { ...settings.stats };

  stats.requestsBlocked += delta.requestsBlocked || 0;
  stats.imagesBlocked += delta.imagesBlocked || 0;
  stats.videosPaused += delta.videosPaused || 0;
  stats.estimatedSavedBytes += delta.estimatedSavedBytes || 0;
  stats.updatedAt = Date.now();

  await chrome.storage.local.set({ stats });
  return stats;
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing, stats: { ...DEFAULT_SETTINGS.stats, ...(existing.stats || {}) } });
  await wakeAndApply({ broadcast: true });
});

chrome.runtime.onStartup.addListener(() => wakeAndApply({ broadcast: true }));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM) wakeAndApply({ broadcast: true });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) return;
  getSettings().then((settings) => {
    if (!settings.enabled) return;
    chrome.tabs.sendMessage(tabId, { type: 'SETTINGS_UPDATED', settings }).catch(() => {});
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const settings = await getSettings();
  if (!settings.enabled) return;
  chrome.tabs.sendMessage(tabId, { type: 'SETTINGS_UPDATED', settings }).catch(() => {});
});

ensureKeepAliveAlarm();
wakeAndApply({ broadcast: true });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const relevant = [
    'enabled', 'mode', 'blockFonts', 'blockMedia', 'blockImages', 'blockTrackers',
    'facebookReelsGuard', 'youtubeControls', 'youtubeDisablePreviews'
  ];
  if (relevant.some((key) => changes[key])) wakeAndApply({ broadcast: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'GET_SETTINGS') {
      sendResponse(await getSettings());
      return;
    }

    if (message?.type === 'SAVE_SETTINGS') {
      await saveSettings(message.payload || {});
      const settings = await wakeAndApply({ broadcast: true });
      sendResponse({ ok: true, settings });
      return;
    }

    if (message?.type === 'RESET_STATS') {
      const stats = { ...DEFAULT_SETTINGS.stats, updatedAt: Date.now() };
      await chrome.storage.local.set({ stats });
      const settings = await getSettings();
      await broadcastSettings(settings);
      sendResponse({ ok: true, stats });
      return;
    }

    if (message?.type === 'ADD_STATS') {
      const stats = await addStats(message.payload || {});
      sendResponse({ ok: true, stats });
      return;
    }

    if (message?.type === 'ESTIMATE') {
      const kind = message.kind || 'tracker';
      sendResponse({ bytes: ESTIMATES[kind] || ESTIMATES.tracker });
      return;
    }
  })().catch((error) => sendResponse({ ok: false, error: String(error) }));

  return true;
});
