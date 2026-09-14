// Shared constants used across background, content-scripts, offscreen, popup, review, options.
// Plain ES module, no bundler — every file that needs these imports directly.

export const MSG = {
  // popup -> background
  START_CAPTURE: 'snapfull:start-capture',
  // background -> content-script
  PREPARE_PAGE: 'snapfull:prepare-page',
  SCROLL_TO: 'snapfull:scroll-to',
  RESTORE_PAGE: 'snapfull:restore-page',
  // content-script -> background
  PAGE_READY: 'snapfull:page-ready',
  SCROLL_SETTLED: 'snapfull:scroll-settled',
  // background -> offscreen
  OFFSCREEN_INIT: 'snapfull:offscreen-init',
  OFFSCREEN_ADD_TILE: 'snapfull:offscreen-add-tile',
  OFFSCREEN_FINISH: 'snapfull:offscreen-finish',
  // offscreen -> background
  OFFSCREEN_READY: 'snapfull:offscreen-ready',
  OFFSCREEN_RESULT: 'snapfull:offscreen-result',
  // background -> popup (status updates while popup is open)
  CAPTURE_PROGRESS: 'snapfull:capture-progress',
  CAPTURE_ERROR: 'snapfull:capture-error',
  CAPTURE_DONE: 'snapfull:capture-done',
};

// Chrome caps a single <canvas> dimension around 32,767px. Stay safely under it
// so we never silently truncate or fail on very tall pages.
export const MAX_CANVAS_HEIGHT = 32000;

// DOM stability window: after a scroll step, wait for this many ms with zero
// mutation events before treating the layout as "settled" and capturing.
export const STABILITY_QUIET_MS = 150;

// Hard ceiling per scroll step so a page that mutates forever (ticking clocks,
// animated ads, infinite-scroll spinners) can't hang the capture indefinitely.
export const STABILITY_MAX_WAIT_MS = 2000;

// Extra delay after scroll before we start watching for mutations, giving
// lazy-loaded images/fonts a moment to kick off their network requests.
export const POST_SCROLL_SETTLE_DELAY_MS = 80;

export const FREE_TIER_DAILY_LIMIT = 5;

export const STORAGE_KEYS = {
  USAGE_COUNT: 'snapfull:usage:count',
  USAGE_DATE: 'snapfull:usage:date',
  LICENSE_CACHE: 'snapfull:license:cache',
  PENDING_CAPTURE: 'snapfull:pending-capture',
};

export const GUMROAD_PRODUCT_PERMALINK = 'REPLACE_WITH_GUMROAD_PRODUCT_PERMALINK';
export const GUMROAD_VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';
export const LICENSE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const LICENSE_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
