import { MSG, STORAGE_KEYS, FREE_TIER_DAILY_LIMIT } from '../shared/constants.js';
import { checkLicense } from '../licensing/license.js';

const captureBtn = document.getElementById('capture-btn');
const statusEl = document.getElementById('status');
const planBadge = document.getElementById('plan-badge');
const usageText = document.getElementById('usage-text');
const usageRow = document.getElementById('usage-row');
const upgradeLink = document.getElementById('upgrade-link');
const optionsLink = document.getElementById('options-link');

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
    const resp = await chrome.runtime.sendMessage({ type: MSG.START_CAPTURE });
    if (!resp || !resp.ok) throw new Error(resp && resp.error || 'Capture failed.');
    setStatus('Done — opening review tab…');
    window.close();
  } catch (err) {
    setStatus(String(err && err.message || err), true);
    captureBtn.disabled = false;
  }
});

upgradeLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + '#upgrade' });
});

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refreshStatus();
