// Offscreen document — the only place in an MV3 extension with DOM/canvas
// access outside a page context. The service worker (background) has none,
// and the popup can close mid-capture and kill any work happening there.
// This document persists for the life of the capture regardless of what the
// user does with the popup, which is the actual fix for the "capture dies if
// you click away" failure class GoFullPage-style extensions are prone to.

import { MSG, MAX_CANVAS_HEIGHT } from '../shared/constants.js';

/** @type {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, height: number}[]} */
let tiles = [];
let tileWidth = 0;
let dpr = 1;
let cursorYInCurrentTile = 0; // device px already filled in the active tile

function newTile(widthPx) {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = 0; // grown as content is drawn, finalized at export
  const ctx = canvas.getContext('2d', { alpha: false });
  return { canvas, ctx, height: 0 };
}

function ensureTileCapacity(addHeightPx) {
  let active = tiles[tiles.length - 1];
  if (!active) {
    active = newTile(tileWidth);
    tiles.push(active);
    cursorYInCurrentTile = 0;
  }
  const maxPx = MAX_CANVAS_HEIGHT * dpr;
  if (cursorYInCurrentTile + addHeightPx > maxPx) {
    // Current tile is full — start a new one so no page ever silently
    // truncates just because it's taller than Chrome's canvas ceiling.
    active = newTile(tileWidth);
    tiles.push(active);
    cursorYInCurrentTile = 0;
  }
  return active;
}

function drawTileImage(dataUrl, cropTopCss) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cropTopPx = Math.round((cropTopCss || 0) * dpr);
      const drawHeightPx = img.height - cropTopPx;
      if (drawHeightPx <= 0) { resolve(); return; }

      const active = ensureTileCapacity(drawHeightPx);
      const newCanvasHeight = cursorYInCurrentTile + drawHeightPx;
      if (active.canvas.height < newCanvasHeight) {
        // Growing a canvas clears it, so preserve existing pixels first.
        const prev = active.canvas.height > 0 ? active.ctx.getImageData(0, 0, active.canvas.width, active.canvas.height) : null;
        active.canvas.height = newCanvasHeight;
        if (prev) active.ctx.putImageData(prev, 0, 0);
      }

      active.ctx.drawImage(
        img,
        0, cropTopPx, img.width, drawHeightPx,
        0, cursorYInCurrentTile, img.width, drawHeightPx
      );

      cursorYInCurrentTile += drawHeightPx;
      active.height = cursorYInCurrentTile;
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
  cursorYInCurrentTile = 0;
  return results;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === MSG.OFFSCREEN_INIT) {
    tiles = [];
    cursorYInCurrentTile = 0;
    tileWidth = Math.round(message.data.totalWidthPx);
    dpr = message.data.dpr || 1;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === MSG.OFFSCREEN_ADD_TILE) {
    drawTileImage(message.data.dataUrl, message.data.cropTopCss)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === MSG.OFFSCREEN_FINISH) {
    finish()
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
