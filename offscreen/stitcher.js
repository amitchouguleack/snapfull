// Offscreen document — the only place in an MV3 extension with DOM/canvas
// access outside a page context. The service worker (background) has none,
// and the popup can close mid-capture and kill any work happening there.
// This document persists for the life of the capture regardless of what the
// user does with the popup, which is the actual fix for the "capture dies if
// you click away" failure class GoFullPage-style extensions are prone to.

import { MSG } from '../shared/constants.js';
import { installGlobalErrorHandlers, logError } from '../shared/diagnostics.js';

// Hidden, local-only diagnostics (see shared/diagnostics.js). Backstop for
// anything that slips past the try/catch already around each message
// handler below. No network call is ever made from this or anywhere
// diagnostics touches.
installGlobalErrorHandlers('offscreen');

/** @type {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}[]} */
let tiles = [];
let dpr = 1;

// Each output canvas is created ONCE, already at its final height, from the
// layout plan the orchestrator computes up front (see planTileLayout in
// background/capture-orchestrator.js). We deliberately never resize a canvas
// after creation: resizing clears its pixels, which previously meant a
// getImageData -> resize -> putImageData round trip on every single tile —
// an O(n^2) copy dance on a large canvas that's also a known way to end up
// with corrupted backing-store content (visible as garbled/noisy output) on
// long pages. Knowing every tile's final size ahead of time removes the need
// to ever resize mid-stream.
function initTiles(totalWidthPx, canvasHeights) {
  tiles = canvasHeights.map((heightPx) => {
    const canvas = document.createElement('canvas');
    canvas.width = totalWidthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext('2d', { alpha: false });
    return { canvas, ctx };
  });
}

function drawTileImage(dataUrl, cropTopCss, canvasIndex, yOffset) {
  return new Promise((resolve, reject) => {
    const target = tiles[canvasIndex];
    if (!target) { reject(new Error(`No output canvas at index ${canvasIndex}`)); return; }

    const img = new Image();
    img.onload = () => {
      const cropTopPx = Math.round((cropTopCss || 0) * dpr);
      const drawHeightPx = img.height - cropTopPx;
      if (drawHeightPx <= 0) { resolve(); return; }

      target.ctx.drawImage(
        img,
        0, cropTopPx, img.width, drawHeightPx,
        0, yOffset, img.width, drawHeightPx
      );
      resolve();
    };
    img.onerror = () => reject(new Error('Failed to decode captured tile image'));
    img.src = dataUrl;
  });
}

async function finish() {
  const results = [];
  for (const tile of tiles) {
    // toBlob is cheaper than toDataURL for large canvases; convert to a
    // base64 data URL only at the very end since that's what crosses the
    // messaging boundary and what chrome.storage.local can persist.
    const blob = await new Promise((resolve) => tile.canvas.toBlob(resolve, 'image/png'));
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    results.push({ dataUrl, width: tile.canvas.width, height: tile.canvas.height });
  }
  // Reset state for the next capture in this same offscreen document.
  tiles = [];
  return results;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === MSG.OFFSCREEN_INIT) {
    try {
      dpr = message.data.dpr || 1;
      initTiles(Math.round(message.data.totalWidthPx), message.data.canvasHeights);
      sendResponse({ ok: true });
    } catch (err) {
      logError('offscreen', err);
      sendResponse({ ok: false, error: String(err) });
    }
    return true;
  }

  if (message.type === MSG.OFFSCREEN_ADD_TILE) {
    const { dataUrl, cropTopCss, canvasIndex, yOffset } = message.data;
    drawTileImage(dataUrl, cropTopCss, canvasIndex, yOffset)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        logError('offscreen', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === MSG.OFFSCREEN_FINISH) {
    finish()
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => {
        logError('offscreen', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  return false;
});
