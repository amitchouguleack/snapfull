// Service worker. Orchestration only — no DOM here, MV3 service workers don't
// have one. Talks to: the content script (scroll + stability), the offscreen
// document (canvas stitching), and chrome.tabs (screenshot capture).

import { MSG, STORAGE_KEYS, FREE_TIER_DAILY_LIMIT, CAPTURE_THROTTLE_MS, MAX_CANVAS_HEIGHT } from '../shared/constants.js';
import { sanitizeFilename } from '../shared/sanitize.js';
import { checkLicense } from '../licensing/license.js';

const CONTENT_SCRIPT_FILE = 'content-scripts/scroll-controller.js';
const OFFSCREEN_URL = 'offscreen/stitcher.html';

let offscreenReady = null; // promise, memoized

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === MSG.START_CAPTURE) {
    runCapture()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // async
  }

  return false;
});

async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts?.({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existing && existing.length > 0) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_SCRAPING'],
      justification: 'Stitch scrolled screenshot tiles into one canvas; service workers have no DOM/canvas access.',
    });
  })();
  return offscreenReady;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');
  if (!tab.url || !/^https?:/.test(tab.url)) {
    throw new Error('SnapFull can only capture regular http(s) pages.');
  }
  return tab;
}

async function ensureHostPermission(tab) {
  // The actual chrome.permissions.request() happens in popup.js, inside the
  // click handler — that's the only place with a genuine user-gesture
  // context. By the time this service worker runs, that context is gone, so
  // a request() call here could silently fail. This is just a defensive
  // check: the popup should always have granted it before sending us
  // START_CAPTURE, but never proceed to script-inject/capture without it.
  const origin = new URL(tab.url).origin + '/*';
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) throw new Error('Missing permission for this page — please try capturing again.');
}

async function checkAndConsumeFreeTierQuota() {
  const license = await checkLicense();
  if (license.plan === 'paid') return;

  const today = new Date().toISOString().slice(0, 10);
  const stored = await chrome.storage.local.get([STORAGE_KEYS.USAGE_COUNT, STORAGE_KEYS.USAGE_DATE]);
  let count = stored[STORAGE_KEYS.USAGE_COUNT] || 0;
  const storedDate = stored[STORAGE_KEYS.USAGE_DATE];
  if (storedDate !== today) count = 0;

  if (count >= FREE_TIER_DAILY_LIMIT) {
    throw new Error(`Free plan limit reached (${FREE_TIER_DAILY_LIMIT}/day). Upgrade for unlimited captures.`);
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.USAGE_COUNT]: count + 1,
    [STORAGE_KEYS.USAGE_DATE]: today,
  });
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCapture() {
  const tab = await getActiveTab();
  await ensureHostPermission(tab);
  await checkAndConsumeFreeTierQuota();

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: [CONTENT_SCRIPT_FILE],
  });

  const prepareResp = await sendToTab(tab.id, { type: MSG.PREPARE_PAGE });
  if (!prepareResp || !prepareResp.ok) throw new Error('Failed to prepare page for capture.');
  const metrics = prepareResp.data;

  const targets = computeScrollTargets(metrics.totalHeight, metrics.viewportHeight);

  // Phase 1: scroll + capture every tile as a raw screenshot. Stitching is
  // deferred to phase 2, once we know the exact crop for every tile — that's
  // what lets us pre-size the output canvas(es) instead of resizing one
  // mid-stream (see planTileLayout below for why that resizing was corrupting
  // long captures).
  const capturedTiles = []; // { dataUrl, cropTopCss }
  let previousBottomCss = 0;
  let lastCaptureAt = 0;
  for (let i = 0; i < targets.length; i++) {
    const targetY = targets[i];
    const scrollResp = await sendToTab(tab.id, { type: MSG.SCROLL_TO, y: targetY });
    if (!scrollResp || !scrollResp.ok) throw new Error('Failed to scroll page during capture.');
    const actualY = scrollResp.data.scrollY;

    const overlapCss = Math.max(0, previousBottomCss - actualY);
    const isFirst = i === 0;
    const cropTopCss = isFirst ? 0 : Math.max(overlapCss, metrics.headerHeight || 0);

    // Chrome caps captureVisibleTab at a few calls/second
    // (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) and throws a quota error if
    // exceeded. The DOM-stability wait alone doesn't guarantee we stay under
    // it — a page that settles instantly would blow through the quota on a
    // long page — so enforce a minimum gap between captures explicitly.
    const sinceLastCapture = Date.now() - lastCaptureAt;
    if (lastCaptureAt && sinceLastCapture < CAPTURE_THROTTLE_MS) {
      await sleep(CAPTURE_THROTTLE_MS - sinceLastCapture);
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    lastCaptureAt = Date.now();

    capturedTiles.push({ dataUrl, cropTopCss });
    previousBottomCss = actualY + metrics.viewportHeight;
  }

  await sendToTab(tab.id, { type: MSG.RESTORE_PAGE });

  // Phase 2: stitch. Lay out every captured tile into one or more output
  // canvases up front (pure arithmetic, no image decoding needed — we
  // already know each tile's device-pixel height from the capture metrics),
  // then hand offscreen a plan it can allocate from once and draw into
  // without ever resizing a canvas mid-stream.
  const viewportHeightPx = Math.round(metrics.viewportHeight * metrics.devicePixelRatio);
  const layout = planTileLayout(capturedTiles, viewportHeightPx, metrics.devicePixelRatio);

  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    type: MSG.OFFSCREEN_INIT,
    data: {
      totalWidthPx: Math.round(metrics.viewportWidth * metrics.devicePixelRatio),
      dpr: metrics.devicePixelRatio,
      canvasHeights: layout.canvasHeights,
    },
  });

  for (let i = 0; i < capturedTiles.length; i++) {
    const placement = layout.placements[i];
    if (!placement) continue; // nothing left to draw for this tile (fully cropped away)
    const { dataUrl, cropTopCss } = capturedTiles[i];
    const addResp = await chrome.runtime.sendMessage({
      type: MSG.OFFSCREEN_ADD_TILE,
      data: { dataUrl, cropTopCss, canvasIndex: placement.canvasIndex, yOffset: placement.yOffset },
    });
    if (!addResp || !addResp.ok) throw new Error(addResp?.error || 'Failed to draw a captured tile.');
  }

  const finishResp = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_FINISH });
  if (!finishResp || !finishResp.ok) throw new Error('Failed to stitch captured tiles.');

  const filenameBase = sanitizeFilename(tab.title);
  const pending = {
    capturedAt: Date.now(),
    sourceUrl: tab.url,
    filenameBase,
    tiles: finishResp.results, // [{dataUrl, width, height}, ...]
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_CAPTURE]: pending });
  await chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') });

  return { tileCount: pending.tiles.length };
}

/**
 * Decides which output canvas each captured tile lands in and at what
 * y-offset, keeping every canvas at or under Chrome's real device-pixel
 * <canvas> height ceiling (MAX_CANVAS_HEIGHT — already a device-pixel value,
 * never multiplied by dpr: that used to be the bug here, since inflating the
 * threshold on a scaled display let a canvas grow past the browser's actual
 * limit and corrupt instead of cleanly splitting).
 *
 * @param {{cropTopCss:number}[]} capturedTiles
 * @param {number} viewportHeightPx device-pixel height of one captured tile before cropping
 * @param {number} dpr
 * @returns {{ canvasHeights: number[], placements: ({canvasIndex:number, yOffset:number}|null)[] }}
 */
function planTileLayout(capturedTiles, viewportHeightPx, dpr) {
  const canvasHeights = [];
  const placements = [];
  let canvasIndex = -1;
  let cursor = 0;

  for (const tile of capturedTiles) {
    const cropTopPx = Math.round((tile.cropTopCss || 0) * dpr);
    const drawHeightPx = viewportHeightPx - cropTopPx;
    if (drawHeightPx <= 0) {
      placements.push(null);
      continue;
    }
    if (canvasIndex === -1 || cursor + drawHeightPx > MAX_CANVAS_HEIGHT) {
      canvasIndex++;
      canvasHeights.push(0);
      cursor = 0;
    }
    placements.push({ canvasIndex, yOffset: cursor });
    cursor += drawHeightPx;
    canvasHeights[canvasIndex] = cursor;
  }

  return { canvasHeights, placements };
}

function computeScrollTargets(totalHeight, viewportHeight) {
  if (totalHeight <= viewportHeight) return [0];
  const targets = [];
  let y = 0;
  while (y < totalHeight - viewportHeight) {
    targets.push(y);
    y += viewportHeight;
  }
  targets.push(totalHeight - viewportHeight);
  return targets;
}
