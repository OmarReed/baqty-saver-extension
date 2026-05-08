const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const modeHelp = {
  light: 'توفير خفيف: مناسب للمواقع الحساسة، يركز على التراكرز وبعض عناصر الخلفية.',
  medium: 'توفير متوسط: أفضل وضع يومي، يقلل الميديا والـ autoplay بدون كسر المواقع المهمة.',
  extreme: 'أقصى توفير: يمنع الصور والميديا الثقيلة قدر الإمكان، وقد يغير شكل بعض المواقع.'
};

const modeTags = {
  light: 'خفيف',
  medium: 'متوسط',
  extreme: 'أقصى'
};

let state = null;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

function formatBytes(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function setChecked(id, value) {
  const el = $(`#${id}`);
  if (el) el.checked = Boolean(value);
}

function render() {
  if (!state) return;

  setChecked('enabled', state.enabled);
  setChecked('blockTrackers', state.blockTrackers);
  setChecked('blockFonts', state.blockFonts);
  setChecked('blockMedia', state.blockMedia);
  setChecked('pauseVideos', state.pauseVideos);
  setChecked('blockImages', state.blockImages);
  setChecked('showBadges', state.showBadges);
  setChecked('facebookReelsGuard', state.facebookReelsGuard);
  setChecked('youtubeControls', state.youtubeControls);
  setChecked('youtubePauseShorts', state.youtubePauseShorts);
  setChecked('youtubeDisablePreviews', state.youtubeDisablePreviews);
  setChecked('youtubeForceLowData', state.youtubeForceLowData);

  $$('.mode').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.mode);
  });

  $('#modeHelp').textContent = modeHelp[state.mode] || modeHelp.medium;
  $('#modeTag').textContent = modeTags[state.mode] || 'متوسط';
  $('#statusPill').textContent = state.enabled ? 'الحماية شغالة' : 'متوقف';
  $('#statusPill').classList.toggle('off', !state.enabled);
  document.body.classList.toggle('disabled', !state.enabled);

  const saved = state.stats?.estimatedSavedBytes || 0;
  $('#savedData').textContent = formatBytes(saved);
  $('#imagesBlocked').textContent = String(state.stats?.imagesBlocked || 0);
  $('#videosPaused').textContent = String(state.stats?.videosPaused || 0);
  $('#requestsBlocked').textContent = String(state.stats?.requestsBlocked || 0);

  const mb = saved / 1024 / 1024;
  const percent = Math.max(9, Math.min(100, Math.round((mb / 250) * 100)));
  $('#meterFill').style.width = `${percent}%`;
}

async function save(patch) {
  state = { ...state, ...patch };
  render();
  const response = await sendMessage({ type: 'SAVE_SETTINGS', payload: patch });
  if (response?.settings) {
    state = response.settings;
    render();
  }
}

function bindToggle(id, key) {
  const el = $(`#${id}`);
  if (!el) return;
  el.addEventListener('change', (event) => save({ [key]: event.target.checked }));
}

async function boot() {
  state = await sendMessage({ type: 'GET_SETTINGS' });
  render();

  bindToggle('enabled', 'enabled');
  bindToggle('blockTrackers', 'blockTrackers');
  bindToggle('blockFonts', 'blockFonts');
  bindToggle('blockMedia', 'blockMedia');
  bindToggle('pauseVideos', 'pauseVideos');
  bindToggle('blockImages', 'blockImages');
  bindToggle('showBadges', 'showBadges');
  bindToggle('facebookReelsGuard', 'facebookReelsGuard');
  bindToggle('youtubeControls', 'youtubeControls');
  bindToggle('youtubePauseShorts', 'youtubePauseShorts');
  bindToggle('youtubeDisablePreviews', 'youtubeDisablePreviews');
  bindToggle('youtubeForceLowData', 'youtubeForceLowData');

  $$('.mode').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.mode;
      const patch = { mode };
      if (mode === 'light') Object.assign(patch, { blockFonts: false, blockMedia: false, blockImages: false });
      if (mode === 'medium') Object.assign(patch, { blockFonts: true, blockMedia: true, blockImages: false, pauseVideos: true });
      if (mode === 'extreme') Object.assign(patch, { blockFonts: true, blockMedia: true, blockImages: true, pauseVideos: true });
      save(patch);
    });
  });

  $('#resetStats').addEventListener('click', async () => {
    const response = await sendMessage({ type: 'RESET_STATS' });
    if (response?.stats) {
      state.stats = response.stats;
      render();
    }
  });

  $('#reloadTab').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.reload(tab.id);
    window.close();
  });
}

boot();
