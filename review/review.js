import { STORAGE_KEYS, MAX_DISPLAY_DIMENSION } from '../shared/constants.js';
import { checkLicense } from '../licensing/license.js';
import { buildPdfFromJpegPages } from '../shared/pdf-export.js';

// Two canvases, on purpose:
//
// - `source` holds the true, full-resolution pixel data (could be tens of
//   thousands of device pixels tall for a long page) and is NEVER appended
//   to the DOM. All edits (crop/redact/highlight/arrow/text) and all exports
//   read from and write to this one — it's the only canvas that has to be
//   pixel-accurate.
// - `display` (#edit-canvas) is the one actually painted on screen, capped
//   to MAX_DISPLAY_DIMENSION and redrawn from `source` after each committed
//   edit. A <canvas> that's appended to the live DOM gets composited by the
//   GPU, which has its own (usually much lower) max texture size than the 2D
//   canvas API's own backing-store limit — exceeding it doesn't error, it
//   just paints as corrupted noise. `source` never gets composited (it's
//   never in the DOM), so it has no such ceiling; `display` needs one.
const display = document.getElementById('edit-canvas');
const displayCtx = display.getContext('2d');
const source = document.createElement('canvas');
const sourceCtx = source.getContext('2d');
let displayScale = 1; // display px per source px, always <= 1

const statusMsg = document.getElementById('status-msg');
const undoBtn = document.getElementById('undo-btn');
const applyCropBtn = document.getElementById('apply-crop-btn');
const tileNav = document.getElementById('tile-nav');
const tileLabel = document.getElementById('tile-label');
const prevTileBtn = document.getElementById('prev-tile-btn');
const nextTileBtn = document.getElementById('next-tile-btn');
const copyBtn = document.getElementById('copy-btn');

/** @type {{dataUrl:string,width:number,height:number}[]} */
let tiles = [];
let tileIndex = 0;
let filenameBase = 'snapfull-capture';
let isPaid = false;

let activeTool = null; // 'crop' | 'redact' | 'highlight' | 'arrow' | 'text'
let dragStart = null; // display-space point
let liveOverlay = null; // display canvas ImageData snapshot, restored while dragging a preview
const undoStack = []; // full-resolution `source` ImageData snapshots, capped
let pendingCropRect = null; // display-space rect, committed by "Apply crop"

const MAX_UNDO = 15;

function setStatus(text, isError) {
  statusMsg.textContent = text || '';
  statusMsg.classList.toggle('error', Boolean(isError));
}

async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PENDING_CAPTURE);
  const pending = stored[STORAGE_KEYS.PENDING_CAPTURE];
  if (!pending || !pending.tiles || !pending.tiles.length) {
    setStatus('No capture found. Close this tab and capture again from the toolbar popup.', true);
    return;
  }
  tiles = pending.tiles;
  filenameBase = pending.filenameBase || filenameBase;

  const license = await checkLicense();
  isPaid = license.plan === 'paid';

  if (tiles.length > 1) {
    tileNav.hidden = false;
  }

  await loadTile(0);
  wireUp();
}

async function loadTile(index) {
  const tile = tiles[index];
  await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      source.width = img.width;
      source.height = img.height;
      sourceCtx.drawImage(img, 0, 0);
      resolve();
    };
    img.onerror = reject;
    img.src = tile.dataUrl;
  });
  tileIndex = index;
  tileLabel.textContent = `Part ${index + 1} / ${tiles.length}`;
  undoStack.length = 0;
  updateUndoBtn();
  syncDisplayFromSource();
}

// Recomputes the capped display size and repaints the on-screen canvas from
// the full-resolution source. Called after every committed edit rather than
// on every pointer move — it's one drawImage call, cheap even for a very
// tall source, and keeps the live-drag preview (which never touches
// `source`) as the only thing running per-frame.
function syncDisplayFromSource() {
  displayScale = Math.min(1, MAX_DISPLAY_DIMENSION / source.width, MAX_DISPLAY_DIMENSION / source.height);
  display.width = Math.max(1, Math.round(source.width * displayScale));
  display.height = Math.max(1, Math.round(source.height * displayScale));
  displayCtx.imageSmoothingEnabled = true;
  displayCtx.imageSmoothingQuality = 'high';
  displayCtx.drawImage(source, 0, 0, source.width, source.height, 0, 0, display.width, display.height);
}

function pushUndoSnapshot() {
  if (undoStack.length >= MAX_UNDO) undoStack.shift();
  undoStack.push(sourceCtx.getImageData(0, 0, source.width, source.height));
  updateUndoBtn();
}

function updateUndoBtn() {
  undoBtn.disabled = undoStack.length === 0;
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  source.width = snap.width;
  source.height = snap.height;
  sourceCtx.putImageData(snap, 0, 0);
  updateUndoBtn();
  syncDisplayFromSource();
}

// Pointer coordinates in *display*-canvas space (what the live drag preview
// draws in). Divide by displayScale to get the equivalent point on `source`.
function displayPointFromEvent(e) {
  const rect = display.getBoundingClientRect();
  const scaleX = display.width / rect.width;
  const scaleY = display.height / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
  };
}

function toSourcePoint(displayPoint) {
  return {
    x: Math.round(displayPoint.x / displayScale),
    y: Math.round(displayPoint.y / displayScale),
  };
}

function normalizedRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function toSourceRect(displayRect) {
  return {
    x: Math.round(displayRect.x / displayScale),
    y: Math.round(displayRect.y / displayScale),
    w: Math.round(displayRect.w / displayScale),
    h: Math.round(displayRect.h / displayScale),
  };
}

function setActiveTool(tool, isPaidTool) {
  if (isPaidTool && !isPaid) {
    setStatus('That tool is part of the paid plan.', true);
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + '#upgrade' });
    return;
  }
  activeTool = activeTool === tool ? null : tool;
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === activeTool);
  });
  applyCropBtn.hidden = activeTool !== 'crop';
  setStatus(activeTool ? `${activeTool[0].toUpperCase()}${activeTool.slice(1)} tool active — drag on the image.` : '');
}

function onPointerDown(e) {
  if (!activeTool) return;
  dragStart = displayPointFromEvent(e);
  liveOverlay = displayCtx.getImageData(0, 0, display.width, display.height);

  if (activeTool === 'text') {
    placeText(toSourcePoint(dragStart));
    dragStart = null;
    liveOverlay = null;
  }
}

// Live drag preview draws only on the small `display` canvas — cheap
// regardless of how tall the underlying page is. Nothing here touches
// `source`; the real, destructive edit is applied once on pointerup.
function onPointerMove(e) {
  if (!activeTool || !dragStart || !liveOverlay) return;
  const current = displayPointFromEvent(e);
  const rect = normalizedRect(dragStart, current);

  displayCtx.putImageData(liveOverlay, 0, 0);
  displayCtx.save();
  if (activeTool === 'crop') {
    displayCtx.strokeStyle = '#2563eb';
    displayCtx.lineWidth = 2;
    displayCtx.setLineDash([6, 4]);
    displayCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    pendingCropRect = rect;
  } else if (activeTool === 'redact') {
    displayCtx.fillStyle = '#000';
    displayCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
  } else if (activeTool === 'highlight') {
    displayCtx.globalAlpha = 0.35;
    displayCtx.fillStyle = '#fde047';
    displayCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
  } else if (activeTool === 'arrow') {
    drawArrow(displayCtx, dragStart, current);
  }
  displayCtx.restore();
}

function onPointerUp(e) {
  if (!activeTool || !dragStart) return;
  const current = displayPointFromEvent(e);
  const rect = normalizedRect(dragStart, current);
  const moved = rect.w > 2 || rect.h > 2;

  if (activeTool === 'crop') {
    // Just leaves the dashed preview + pendingCropRect; "Apply crop" commits it.
  } else if (moved) {
    // Commit the destructive edit onto `source`, at source resolution — this
    // is the pixel data that undo/export actually read, and it's what makes
    // redaction genuinely destroy the covered pixels rather than just draw
    // over a small preview copy of them.
    pushUndoSnapshot();
    const sourceRect = toSourceRect(rect);
    sourceCtx.save();
    if (activeTool === 'redact') {
      sourceCtx.fillStyle = '#000';
      sourceCtx.fillRect(sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h);
    } else if (activeTool === 'highlight') {
      sourceCtx.globalAlpha = 0.35;
      sourceCtx.fillStyle = '#fde047';
      sourceCtx.fillRect(sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h);
    } else if (activeTool === 'arrow') {
      drawArrow(sourceCtx, toSourcePoint(dragStart), toSourcePoint(current));
    }
    sourceCtx.restore();
    syncDisplayFromSource();
  } else {
    // Click without drag — discard the preview.
    displayCtx.putImageData(liveOverlay, 0, 0);
  }

  dragStart = null;
  liveOverlay = null;
}

function drawArrow(context, from, to) {
  const headLength = Math.max(10, Math.min(30, Math.hypot(to.x - from.x, to.y - from.y) * 0.2));
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  context.strokeStyle = '#dc2626';
  context.fillStyle = '#dc2626';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(to.x - headLength * Math.cos(angle - Math.PI / 6), to.y - headLength * Math.sin(angle - Math.PI / 6));
  context.lineTo(to.x - headLength * Math.cos(angle + Math.PI / 6), to.y - headLength * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fill();
}

function placeText(sourcePoint) {
  const text = window.prompt('Text to add:');
  if (!text) return;
  pushUndoSnapshot();
  sourceCtx.save();
  sourceCtx.font = '24px -apple-system, Segoe UI, Roboto, sans-serif';
  sourceCtx.fillStyle = '#dc2626';
  sourceCtx.fillText(text, sourcePoint.x, sourcePoint.y);
  sourceCtx.restore();
  syncDisplayFromSource();
}

function applyCrop() {
  if (!pendingCropRect || pendingCropRect.w < 2 || pendingCropRect.h < 2) {
    setStatus('Drag a region first.', true);
    return;
  }
  pushUndoSnapshot();
  const { x, y, w, h } = toSourceRect(pendingCropRect);
  const cropped = sourceCtx.getImageData(x, y, w, h);
  source.width = w;
  source.height = h;
  sourceCtx.putImageData(cropped, 0, 0);
  pendingCropRect = null;
  setActiveTool('crop', false); // toggle off
  syncDisplayFromSource();
  setStatus('Cropped.');
}

// Exports always read from `source` (full resolution) — never from
// `display`, which is a downscaled preview only.
function withWatermark(srcCanvas) {
  if (isPaid) return srcCanvas;
  const out = document.createElement('canvas');
  out.width = srcCanvas.width;
  out.height = srcCanvas.height;
  const octx = out.getContext('2d');
  octx.drawImage(srcCanvas, 0, 0);
  const label = 'SnapFull';
  octx.font = `${Math.max(12, Math.round(srcCanvas.width * 0.015))}px sans-serif`;
  const metrics = octx.measureText(label);
  const pad = 8;
  const x = out.width - metrics.width - pad * 2;
  const y = out.height - pad * 2;
  octx.fillStyle = 'rgba(0,0,0,0.45)';
  octx.fillRect(x, y - 16, metrics.width + pad * 2, 24);
  octx.fillStyle = '#fff';
  octx.fillText(label, x + pad, y);
  return out;
}

function canvasToBlob(srcCanvas, mime, quality) {
  return new Promise((resolve) => srcCanvas.toBlob(resolve, mime, quality));
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    // Revoke after a delay so the download has time to start reading the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

async function exportCurrent(format) {
  const paidFormats = ['jpeg', 'pdf'];
  if (paidFormats.includes(format) && !isPaid) {
    setStatus('That export format is part of the paid plan.', true);
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + '#upgrade' });
    return;
  }

  const finalCanvas = withWatermark(source);
  const suffix = tiles.length > 1 ? `-part${tileIndex + 1}` : '';

  if (format === 'png') {
    const blob = await canvasToBlob(finalCanvas, 'image/png');
    await downloadBlob(blob, `${filenameBase}${suffix}.png`);
    setStatus('PNG downloaded.');
  } else if (format === 'jpeg') {
    const blob = await canvasToBlob(finalCanvas, 'image/jpeg', 0.92);
    await downloadBlob(blob, `${filenameBase}${suffix}.jpg`);
    setStatus('JPEG downloaded.');
  } else if (format === 'pdf') {
    const blob = await canvasToBlob(finalCanvas, 'image/jpeg', 0.9);
    const jpegBytes = new Uint8Array(await blob.arrayBuffer());
    const pdfBlob = buildPdfFromJpegPages([
      { jpegBytes, widthPx: finalCanvas.width, heightPx: finalCanvas.height },
    ]);
    await downloadBlob(pdfBlob, `${filenameBase}${suffix}.pdf`);
    setStatus('PDF downloaded.');
  }
}

async function copyToClipboard() {
  try {
    const finalCanvas = withWatermark(source);
    const blob = await canvasToBlob(finalCanvas, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('Copied to clipboard.');
  } catch (err) {
    setStatus('Could not copy to clipboard: ' + String(err && err.message || err), true);
  }
}

function wireUp() {
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTool(btn.dataset.tool, btn.dataset.paid === '1'));
  });

  display.addEventListener('pointerdown', onPointerDown);
  display.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  undoBtn.addEventListener('click', undo);
  applyCropBtn.addEventListener('click', applyCrop);
  copyBtn.addEventListener('click', copyToClipboard);

  document.querySelectorAll('.export-btn').forEach((btn) => {
    btn.addEventListener('click', () => exportCurrent(btn.dataset.format));
  });

  prevTileBtn.addEventListener('click', () => {
    if (tileIndex > 0) loadTile(tileIndex - 1);
  });
  nextTileBtn.addEventListener('click', () => {
    if (tileIndex < tiles.length - 1) loadTile(tileIndex + 1);
  });
}

init();
