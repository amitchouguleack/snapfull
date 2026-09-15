import { MSG, STORAGE_KEYS, FREE_TIER_DAILY_LIMIT } from '../shared/constants.js';
import { checkLicense } from '../licensing/license.js';

const captureBtn = document.getElementById('capture-btn');
const statusEl = document.getElementById('status');
const planBadge = document.getElementById('plan-badge');
const usageText = document.getElementById('usage-text');
const usageRow = document.getElementById('usage-row');
const upgradeLink = document.getElementById('upgrade-link');
const optionsLink = document.getElementById('options-link');
const logo = document.getElementById('logo');

async function refreshStatus() {
  const license = await checkLicense();
  const isPaid = license.plan === 'paid';

  planBadge.textContent = isPaid ? 'Paid' : 'Free';
  planBadge.classList.toggle('paid', isPaid);
  usageRow.hidden = isPaid;

  if (!isPaid) {
    const today = new Date().toISOString().slice(0, 10);
    const stored = await chrome.storage.local.get([STORAGE_KEYS.USAGE_COUNT, STORAGE_KEYS.USAGE_DATE]);
    const count = stored[STORAGE_KEYS.USAGE_DATE] === today ? (stored[STORAGE_KEYS.USAGE_COUNT] || 0) : 0;
    usageText.textContent = `${count} / ${FREE_TIER_DAILY_LIMIT} captures today`;
    captureBtn.disabled = count >= FREE_TIER_DAILY_LIMIT;
    if (captureBtn.disabled) {
      setStatus('Daily limit reached. Upgrade for unlimited captures.', true);
    }
  }
}

function setStatus(text, isError) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  setStatus('Capturing… this stays open even if you close this popup.');

  try {
    // The host-permission prompt must be requested from a user-gesture
    // context. A service worker is not one by the time an async message
    // chain reaches it, so we request it here, directly inside this click
    // handler, before handing off to the background orchestrator.
    await ensureHostPermissionForActiveTab();

    const resp = await chrome.runtime.sendMessage({ type: MSG.START_CAPTURE });
    if (!resp || !resp.ok) throw new Error(resp && resp.error || 'Capture failed.');
    setStatus('Done — opening review tab…');
    window.close();
  } catch (err) {
    setStatus(String(err && err.message || err), true);
    captureBtn.disabled = false;
  }
});

async function ensureHostPermissionForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    throw new Error('SnapFull can only capture regular http(s) pages.');
  }
  const origin = new URL(tab.url).origin + '/*';
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error('Permission to read this page was denied.');
}

upgradeLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + '#upgrade' });
});

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// The popup is normally short-lived (recreated fresh each time it opens, so
// refreshStatus() on load is usually enough on its own) but it can stay open
// while the user activates a license in another tab — e.g. clicking
// "Options" opens options.html without necessarily closing this popup.
// Without this, the Free/Paid badge and the capture-button gating would show
// whatever was true when the popup happened to open, same class of bug as
// review.js's lock icons before that was fixed.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (STORAGE_KEYS.LICENSE_CACHE in changes || STORAGE_KEYS.USAGE_COUNT in changes)) {
    refreshStatus();
  }
});

// Hidden diagnostics trigger: 6 clicks on the logo within ~3 seconds opens
// the diagnostics tab. Deliberately undiscoverable by accident (a stray
// double-click on the title does nothing) but easy to remember once you
// know it's there. Nothing about this trigger itself is logged anywhere.
const LOGO_TAP_COUNT = 6;
const LOGO_TAP_WINDOW_MS = 3000;
let logoTapTimestamps = [];
logo.addEventListener('click', () => {
  const now = Date.now();
  logoTapTimestamps = logoTapTimestamps.filter((t) => now - t < LOGO_TAP_WINDOW_MS);
  logoTapTimestamps.push(now);
  if (logoTapTimestamps.length >= LOGO_TAP_COUNT) {
    logoTapTimestamps = [];
    chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics/diagnostics.html') });
  }
});

refreshStatus();
