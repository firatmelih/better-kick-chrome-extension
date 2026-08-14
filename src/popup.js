const DEFAULTS = {
  plainChat: true,
  stripEmoji: true,
  removeLinks: false,
  hideSubs: true,
  hideDrops: true,
  hidePinned: true,
  killAnimations: true,
  purpleTheme: true,
  monoUsernames: false,
  hideTimestamps: false,
  hideEmpty: true,
  hideRepeats: true,
  deletedLog: true,
  force1080: true,
  smoothScroll: true,
  rememberBrowse: true,
  rememberPanels: true
};

const KEYS = Object.keys(DEFAULTS);
const statusEl = document.getElementById('status');
let statusTimer;

function flash(msg) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ''), 1600);
}

function render(values) {
  for (const key of KEYS) {
    const box = document.getElementById(key);
    if (box) box.checked = Boolean(values[key]);
  }
}

chrome.storage.sync.get(DEFAULTS, (stored) => render(stored));

for (const key of KEYS) {
  const box = document.getElementById(key);
  if (!box) continue;
  box.addEventListener('change', () => {
    chrome.storage.sync.set({ [key]: box.checked }, () => {
      // Hiding is pure CSS, so toggles apply live. Text already stripped from
      // a message can only come back on reload.
      flash(box.checked ? 'On' : 'Off — reload to restore');
    });
  });
}

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.sync.set(DEFAULTS, () => {
    render(DEFAULTS);
    flash('Defaults restored');
  });
});
