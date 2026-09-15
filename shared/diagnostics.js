// Hidden, local-only diagnostics. Everything here reads and writes
// chrome.storage.local exclusively — there is no network call anywhere in
// this file, and there must never be one added to it. It exists purely so
// the developer can look at a plain-English error/capture history on their
// own machine; nothing here is ever sent anywhere automatically.

import { STORAGE_KEYS, MAX_ERROR_LOG_ENTRIES, MAX_CAPTURE_LOG_ENTRIES } from './constants.js';

/**
 * Appends one entry to the rolling error log (capped at
 * MAX_ERROR_LOG_ENTRIES, oldest dropped first). Never throws — a failure to
 * log a diagnostic must never itself break the thing it was logging.
 * @param {string} component 'background' | 'content-script' | 'offscreen' | 'review'
 * @param {unknown} error
 */
export async function logError(component, error) {
  try {
    const message = errorToMessage(error);
    if (!message) return;
    const entry = { ts: Date.now(), component, message: message.slice(0, 500) };
    const stored = await chrome.storage.local.get(STORAGE_KEYS.ERROR_LOG);
    const log = Array.isArray(stored[STORAGE_KEYS.ERROR_LOG]) ? stored[STORAGE_KEYS.ERROR_LOG] : [];
    log.push(entry);
    while (log.length > MAX_ERROR_LOG_ENTRIES) log.shift();
    await chrome.storage.local.set({ [STORAGE_KEYS.ERROR_LOG]: log });
  } catch {
    // Swallow — diagnostics logging is best-effort and must never surface
    // its own errors to the caller.
  }
}

/**
 * Appends one entry to the rolling capture-result log (capped at
 * MAX_CAPTURE_LOG_ENTRIES). Deliberately carries no page title, URL, or
 * pixel data — just enough to answer "did captures recently work."
 * @param {{ ok: boolean, tileCount?: number, error?: string }} result
 */
export async function logCaptureResult(result) {
  try {
    const entry = { ts: Date.now(), ok: Boolean(result.ok), tileCount: result.tileCount ?? null, error: result.error ? String(result.error).slice(0, 500) : null };
    const stored = await chrome.storage.local.get(STORAGE_KEYS.CAPTURE_LOG);
    const log = Array.isArray(stored[STORAGE_KEYS.CAPTURE_LOG]) ? stored[STORAGE_KEYS.CAPTURE_LOG] : [];
    log.push(entry);
    while (log.length > MAX_CAPTURE_LOG_ENTRIES) log.shift();
    await chrome.storage.local.set({ [STORAGE_KEYS.CAPTURE_LOG]: log });
  } catch {
    // Same as logError — best-effort, never throws.
  }
}

function errorToMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Installs window/self-level catch-alls for anything that slips past a
 * component's own try/catch blocks. This is a backstop, not the primary
 * mechanism — each component still logs its own expected failure points
 * directly, with more context than a generic error event carries.
 * @param {string} component
 * @param {EventTarget} [scope] defaults to `self` (works for both a service
 *   worker's global scope and a regular window)
 */
export function installGlobalErrorHandlers(component, scope) {
  const target = scope || (typeof self !== 'undefined' ? self : undefined);
  if (!target) return;
  target.addEventListener('error', (event) => {
    logError(component, (event && event.error) || (event && event.message) || 'Unknown script error');
  });
  target.addEventListener('unhandledrejection', (event) => {
    logError(component, event && event.reason);
  });
}

// Plain-English translations for the error messages this codebase actually
// throws. Matched by substring/regex against the raw message. Deliberately
// small and specific — a translation you can trust beats a generic one that
// might be misleading, so an unmatched error falls back to showing the raw
// message with a note rather than guessing.
const TRANSLATIONS = [
  [/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i,
    'The screenshot tool tried to capture faster than Chrome allows. This is usually harmless — capture should still finish. If it keeps happening, try again in a few seconds.'],
  [/Missing permission for this page/i,
    'SnapFull needs permission to read this page, which is normally granted automatically when you click Capture. Try clicking Capture again.'],
  [/Free plan limit reached/i,
    'The free plan\'s daily capture limit was reached. Upgrade for unlimited captures, or wait until tomorrow.'],
  [/Failed to prepare page for capture/i,
    'SnapFull couldn\'t read the page\'s layout to start capturing. This can happen on pages that block extensions, or if the page hadn\'t finished loading yet.'],
  [/Failed to scroll page during capture/i,
    'SnapFull lost contact with the page while scrolling through it — often because the page navigated away or reloaded mid-capture.'],
  [/Failed to stitch captured tiles/i,
    'SnapFull captured the page but hit a problem combining the pieces into one image.'],
  [/Failed to draw a captured tile/i,
    'SnapFull captured the page but hit a problem combining one of the pieces into the final image.'],
  [/No output canvas at index/i,
    'An internal step in combining the screenshot pieces went out of sync.'],
  [/No active tab found/i,
    'SnapFull couldn\'t find the browser tab to capture.'],
  [/can only capture regular http\(s\) pages/i,
    'This page can\'t be captured — SnapFull only works on normal web pages, not Chrome\'s internal pages, the Web Store, or local files.'],
  [/Permission to read this page was denied/i,
    'The permission prompt needed to capture this page was declined.'],
  [/Gumroad verify failed/i,
    'SnapFull couldn\'t reach Gumroad to check your license. Your plan status stays as last known for up to 7 days, so this shouldn\'t affect you immediately.'],
  [/Failed to decode captured tile image/i,
    'One of the captured screenshot pieces was corrupted and couldn\'t be used.'],
  [/No capture found/i,
    'The review tab was opened without a capture to show — usually means it was opened directly rather than from a completed capture.'],
];

/**
 * @param {string} message raw error message
 * @returns {string} a plain-English explanation, or the raw message with a
 *   note if nothing in TRANSLATIONS matches
 */
export function humanizeError(message) {
  if (!message) return 'An unknown error occurred.';
  for (const [pattern, plain] of TRANSLATIONS) {
    if (pattern.test(message)) return plain;
  }
  return `(No plain-English translation for this one yet.) Raw message: "${message}"`;
}

function formatTimestamp(ts) {
  if (!ts) return 'never';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/**
 * Reads everything the diagnostics tab shows, as plain data. Does NOT call
 * checkLicense() from licensing/license.js — that function can trigger a
 * live Gumroad network call if its cache has gone stale, and opening this
 * panel must never make a network call under any circumstance. Instead this
 * reads the cached license status directly and reports it as "last checked
 * at <time>", which is accurate and honest about when it was actually
 * verified.
 * @returns {Promise<{
 *   extensionVersion: string,
 *   chromeVersion: string,
 *   plan: { status: string, lastChecked: string, source: string },
 *   errors: { ts: number, component: string, message: string, plain: string }[],
 *   captures: { ts: number, ok: boolean, tileCount: number|null, error: string|null, plain: string|null }[],
 * }>}
 */
export async function collectDiagnostics() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ERROR_LOG,
    STORAGE_KEYS.CAPTURE_LOG,
    STORAGE_KEYS.LICENSE_CACHE,
  ]);

  const errorLog = Array.isArray(stored[STORAGE_KEYS.ERROR_LOG]) ? stored[STORAGE_KEYS.ERROR_LOG] : [];
  const captureLog = Array.isArray(stored[STORAGE_KEYS.CAPTURE_LOG]) ? stored[STORAGE_KEYS.CAPTURE_LOG] : [];
  const licenseCache = stored[STORAGE_KEYS.LICENSE_CACHE] || null;

  const manifest = chrome.runtime.getManifest();
  const chromeMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);

  return {
    extensionVersion: manifest.version || 'unknown',
    chromeVersion: chromeMatch ? chromeMatch[1] : 'unknown',
    plan: {
      // Deliberately not "Paid"/"Free" alone — spells out whether this is a
      // live-verified status or one we're trusting from before, since that
      // distinction matters for reading the report honestly.
      status: !licenseCache || !licenseCache.licenseKey
        ? 'Free (no license key entered)'
        : licenseCache.valid
          ? 'Paid'
          : 'Free (license key entered but not currently valid)',
      lastChecked: licenseCache ? formatTimestamp(licenseCache.lastChecked) : 'never',
      source: licenseCache ? (licenseCache.valid ? 'cached from last successful check' : 'cached') : 'no license on file',
    },
    errors: errorLog.slice().reverse().map((e) => ({
      ...e,
      tsLabel: formatTimestamp(e.ts),
      plain: humanizeError(e.message),
    })),
    captures: captureLog.slice().reverse().map((c) => ({
      ...c,
      tsLabel: formatTimestamp(c.ts),
      plain: c.error ? humanizeError(c.error) : null,
    })),
  };
}

/**
 * Renders collectDiagnostics()'s output as one plain-text block, formatted
 * for a human to read or paste into an email/message — this is exactly what
 * "Copy Report" puts on the clipboard, and nothing else ever touches it.
 * @param {Awaited<ReturnType<typeof collectDiagnostics>>} data
 */
export function formatDiagnosticsReport(data) {
  const lines = [];
  lines.push('SnapFull Diagnostics Report');
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push(`Extension version: ${data.extensionVersion}`);
  lines.push(`Chrome version: ${data.chromeVersion}`);
  lines.push('');
  lines.push('Plan status');
  lines.push(`  ${data.plan.status}`);
  lines.push(`  Last checked: ${data.plan.lastChecked} (${data.plan.source})`);
  lines.push('');
  lines.push(`Recent captures (${data.captures.length})`);
  if (data.captures.length === 0) {
    lines.push('  No captures recorded yet.');
  } else {
    for (const c of data.captures) {
      if (c.ok) {
        lines.push(`  [${c.tsLabel}] Success — ${c.tileCount ?? '?'} piece(s)`);
      } else {
        lines.push(`  [${c.tsLabel}] Failed — ${c.plain || c.error || 'unknown reason'}`);
      }
    }
  }
  lines.push('');
  lines.push(`Recent errors (${data.errors.length})`);
  if (data.errors.length === 0) {
    lines.push('  Nothing has errored recently.');
  } else {
    for (const e of data.errors) {
      lines.push(`  [${e.tsLabel}] (${e.component}) ${e.plain}`);
    }
  }
  lines.push('');
  lines.push('This report was generated locally and has not been sent anywhere.');
  return lines.join('\n');
}
