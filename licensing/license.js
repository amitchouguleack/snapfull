// Gumroad Membership license verification. Zero backend: the only outbound
// network call this extension ever makes is this one, to Gumroad's public API.
// Everything else (cache, usage counters, prefs) stays in chrome.storage.local.

import {
  STORAGE_KEYS,
  GUMROAD_PRODUCT_PERMALINK,
  GUMROAD_VERIFY_URL,
  LICENSE_GRACE_PERIOD_MS,
  LICENSE_RECHECK_INTERVAL_MS,
} from '../shared/constants.js';

/**
 * @typedef {{ plan: 'free'|'paid', valid: boolean, lastChecked: number, licenseKey: string|null, source: 'network'|'cache'|'grace'|'none' }} LicenseStatus
 */

/** @returns {Promise<LicenseStatus>} */
export async function checkLicense() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.LICENSE_CACHE);
  const cache = stored[STORAGE_KEYS.LICENSE_CACHE];

  if (!cache || !cache.licenseKey) {
    return { plan: 'free', valid: false, lastChecked: 0, licenseKey: null, source: 'none' };
  }

  const age = Date.now() - (cache.lastChecked || 0);
  if (age < LICENSE_RECHECK_INTERVAL_MS) {
    // Recently verified — trust the cache, don't hit the network on every capture.
    return { ...cache, source: 'cache' };
  }

  try {
    const fresh = await verifyWithGumroad(cache.licenseKey);
    await chrome.storage.local.set({ [STORAGE_KEYS.LICENSE_CACHE]: fresh });
    return { ...fresh, source: 'network' };
  } catch (err) {
    // Gumroad unreachable (their outage, user offline, etc.) — never hard-lock
    // a paying user out because our $0 infra had a bad day. Keep the last
    // known-valid status for up to LICENSE_GRACE_PERIOD_MS.
    if (cache.valid && age < LICENSE_GRACE_PERIOD_MS) {
      return { ...cache, source: 'grace' };
    }
    return { plan: 'free', valid: false, lastChecked: cache.lastChecked, licenseKey: cache.licenseKey, source: 'grace-expired' };
  }
}

/**
 * @param {string} licenseKey
 * @returns {Promise<LicenseStatus>}
 */
async function verifyWithGumroad(licenseKey) {
  const body = new URLSearchParams({
    product_permalink: GUMROAD_PRODUCT_PERMALINK,
    license_key: licenseKey,
    // Do not increment Gumroad's internal uses counter on routine background
    // rechecks — only count an actual new activation.
    increment_uses_count: 'false',
  });

  const resp = await fetch(GUMROAD_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) throw new Error(`Gumroad verify failed: HTTP ${resp.status}`);
  const json = await resp.json();

  const purchase = json.purchase || {};
  const isValid = Boolean(json.success) && !purchase.refunded && !purchase.chargebacked && !purchase.subscription_cancelled_at;

  return {
    plan: isValid ? 'paid' : 'free',
    valid: isValid,
    lastChecked: Date.now(),
    licenseKey,
  };
}

/**
 * Called from the options page when the user pastes a new key. Always hits
 * the network immediately (this is a deliberate user action, not a routine
 * recheck) so they get instant feedback on whether the key is good.
 * @param {string} licenseKey
 */
export async function activateLicense(licenseKey) {
  const trimmed = (licenseKey || '').trim();
  if (!trimmed) throw new Error('Enter a license key.');
  const status = await verifyWithGumroad(trimmed);
  await chrome.storage.local.set({ [STORAGE_KEYS.LICENSE_CACHE]: status });
  return status;
}

export async function clearLicense() {
  await chrome.storage.local.remove(STORAGE_KEYS.LICENSE_CACHE);
}
