const DEFAULTS = {
  simpleChat: true,
  showDeleted: true,
  rememberSettings: true,
  purpleTheme: true
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
      // Every toggle is read live off <html data-bpk-*>, so no reload.
      flash(box.checked ? 'On' : 'Off');
    });
  });
}

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.sync.set(DEFAULTS, () => {
    render(DEFAULTS);
    flash('Defaults restored');
  });
});
