import { GUMROAD_PRODUCT_URL } from '../shared/constants.js';
import { checkLicense, activateLicense, clearLicense } from '../licensing/license.js';

const planStatus = document.getElementById('plan-status');
const buyLink = document.getElementById('buy-link');
const licenseInput = document.getElementById('license-input');
const activateBtn = document.getElementById('activate-btn');
const clearBtn = document.getElementById('clear-btn');
const licenseMessage = document.getElementById('license-message');

buyLink.href = GUMROAD_PRODUCT_URL;

async function render() {
  const license = await checkLicense();
  if (license.plan === 'paid') {
    planStatus.textContent = 'You are on the paid plan. Thanks for supporting SnapFull!';
    licenseInput.value = license.licenseKey || '';
  } else if (license.licenseKey) {
    planStatus.textContent = 'Your license key could not be verified — you are on the free plan.';
  } else {
    planStatus.textContent = 'You are on the free plan (5 captures/day).';
  }
}

activateBtn.addEventListener('click', async () => {
  activateBtn.disabled = true;
  licenseMessage.textContent = 'Verifying…';
  try {
    const status = await activateLicense(licenseInput.value);
    licenseMessage.textContent = status.valid
      ? 'License activated — paid plan unlocked.'
      : 'That key did not verify. Double-check it and try again.';
    await render();
  } catch (err) {
    licenseMessage.textContent = String(err && err.message || err);
  } finally {
    activateBtn.disabled = false;
  }
});

clearBtn.addEventListener('click', async () => {
  await clearLicense();
  licenseInput.value = '';
  licenseMessage.textContent = 'License key removed.';
  await render();
});

render();
