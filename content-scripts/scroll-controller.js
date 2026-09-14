// Drives scroll position for full-page capture and reports back once the DOM
// has "settled" after each scroll step, instead of GoFullPage's flat
// setTimeout delay. This is what makes capture reliable on lazy-loaded /
// infinite-scroll pages: we watch real mutations and wait for them to stop.
//
// Runs once per capture, injected on demand via chrome.scripting.executeScript
// (not declared statically in the manifest) so it only ever touches the tab
// the user explicitly asked us to capture.

(() => {
  const MSG = {
    PREPARE_PAGE: 'snapfull:prepare-page',
    SCROLL_TO: 'snapfull:scroll-to',
    RESTORE_PAGE: 'snapfull:restore-page',
    PAGE_READY: 'snapfull:page-ready',
    SCROLL_SETTLED: 'snapfull:scroll-settled',
  };

  const STABILITY_QUIET_MS = 150;
  const STABILITY_MAX_WAIT_MS = 2000;
  const POST_SCROLL_SETTLE_DELAY_MS = 80;

  // Avoid double-injection if a capture is triggered twice in the same tab.
  if (window.__snapfullControllerInstalled) return;
  window.__snapfullControllerInstalled = true;

  let originalOverflow = null;
  let originalScrollBehavior = null;
  let fixedHeaderEls = [];

  function getPageMetrics() {
    const de = document.documentElement;
    const body = document.body;
    const totalHeight = Math.max(
      de.scrollHeight, body ? body.scrollHeight : 0,
      de.offsetHeight, body ? body.offsetHeight : 0
    );
    const totalWidth = Math.max(
      de.scrollWidth, body ? body.scrollWidth : 0,
      de.offsetWidth, body ? body.offsetWidth : 0
    );
    return {
      totalHeight,
      totalWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  }

  // Detects position:fixed / sticky elements near the top of the viewport
  // (site headers/nav bars) so the orchestrator can crop them out of every
  // tile after the first, instead of repeating a duplicated header band in
  // the stitched image.
  function detectFixedHeaders() {
    const found = [];
    const candidates = document.querySelectorAll('body *');
    let checked = 0;
    for (const el of candidates) {
      if (checked > 2000) break; // cap DOM walk cost on huge pages
      checked++;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0 || rect.height > window.innerHeight * 0.5) continue;
      if (rect.top > 4) continue; // only near-top elements are "headers"
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        found.push({ height: Math.ceil(rect.height) });
      }
    }
    // Largest reported height wins if there are overlapping matches.
    found.sort((a, b) => b.height - a.height);
    return found.length ? found[0].height : 0;
  }

  function prepare() {
    originalOverflow = document.documentElement.style.overflow;
    originalScrollBehavior = document.documentElement.style.scrollBehavior;
    // Disable smooth scrolling so scrollTo() is synchronous/predictable.
    document.documentElement.style.scrollBehavior = 'auto';

    const metrics = getPageMetrics();
    const headerHeight = detectFixedHeaders();
    return { ...metrics, headerHeight };
  }

  function restore() {
    document.documentElement.style.overflow = originalOverflow || '';
    document.documentElement.style.scrollBehavior = originalScrollBehavior || '';
    window.scrollTo(0, 0);
  }

  function waitForStability() {
    return new Promise((resolve) => {
      let quietTimer = null;
      const hardStop = setTimeout(() => {
        observer.disconnect();
        clearTimeout(quietTimer);
        resolve();
      }, STABILITY_MAX_WAIT_MS);

      const observer = new MutationObserver(() => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          observer.disconnect();
          clearTimeout(hardStop);
          resolve();
        }, STABILITY_QUIET_MS);
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // Start the quiet timer immediately in case nothing mutates at all.
      quietTimer = setTimeout(() => {
        observer.disconnect();
        clearTimeout(hardStop);
        resolve();
      }, STABILITY_QUIET_MS);
    });
  }

  async function scrollToAndSettle(y) {
    window.scrollTo(0, y);
    // Nudge lazy-load observers (many libs use IntersectionObserver keyed to
    // viewport position) a brief moment before we start watching for DOM churn.
    await new Promise((r) => setTimeout(r, POST_SCROLL_SETTLE_DELAY_MS));
    await waitForStability();
    return { scrollY: window.scrollY, scrollX: window.scrollX };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === MSG.PREPARE_PAGE) {
      const data = prepare();
      sendResponse({ ok: true, data });
      return true;
    }

    if (message.type === MSG.SCROLL_TO) {
      scrollToAndSettle(message.y).then((data) => {
        sendResponse({ ok: true, data });
      });
      return true; // async response
    }

    if (message.type === MSG.RESTORE_PAGE) {
      restore();
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
})();
