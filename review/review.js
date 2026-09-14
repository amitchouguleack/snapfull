import { STORAGE_KEYS } from '../shared/constants.js';
import { checkLicense } from '../licensing/license.js';
import { buildPdfFromJpegPages } from '../shared/pdf-export.js';

const canvas = document.getElementById('edit-canvas');
const ctx = canvas.getContext('2d');
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
let dragStart = null;
let liveOverlay = null; // canvas ImageData snapshot to restore while dragging preview
const undoStack = []; // ImageData snapshots, capped

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
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      resolve();
    };
    img.onerror = reject;
    img.src = tile.dataUrl;
  });
  tileIndex = index;
  tileLabel.textContent = `Part ${index + 1} / ${tiles.length}`;
  undoStack.length = 0;
  updateUndoBtn();
}

function pushUndoSnapshot() {
  if (undoStack.length >= MAX_UNDO) undoStack.shift();
  undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  updateUndoBtn();
}

function updateUndoBtn() {
  undoBtn.disabled = undoStack.length === 0;
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  canvas.width = snap.width;
  canvas.height = snap.height;
  ctx.putImageData(snap, 0, 0);
  updateUndoBtn();
}

function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
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

let pendingCropRect = null;

function onPointerDown(e) {
  if (!activeTool) return;
  dragStart = canvasPointFromEvent(e);
  liveOverlay = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (activeTool === 'text') {
    placeText(dragStart);
    dragStart = null;
    liveOverlay = null;
  }
}

function onPointerMove(e) {
  if (!activeTool || !dragStart || !liveOverlay) return;
  const current = canvasPointFromEvent(e);
  const rect = normalizedRect(dragStart, current);

  ctx.putImageData(liveOverlay, 0, 0);
  ctx.save();
  if (activeTool === 'crop') {
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    pendingCropRect = rect;
  } else if (activeTool === 'redact') {
    ctx.fillStyle = '#000';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  } else if (activeTool === 'highlight') {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#fde047';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  } else if (activeTool === 'arrow') {
    drawArrow(ctx, dragStart, current);
  }
  ctx.restore();
}

function onPointerUp(e) {
  if (!activeTool || !dragStart) return;
  const current = canvasPointFromEvent(e);
  const rect = normalizedRect(dragStart, current);
  const moved = rect.w > 2 || rect.h > 2;

  if (activeTool === 'crop') {
    // Just leaves the dashed preview + pendingCropRect; "Apply crop" commits it.
  } else if (moved) {
    // Redact/highlight/arrow are destructive the moment the drag ends: the
    // pixels drawn during onPointerMove are already baked into the canvas,
    // so there is no separate "reveal" layer that could leak the original
    // content — this satisfies the redaction security requirement directly.
    pushUndoSnapshot_beforeThisStroke();
  } else {
    // Click without drag — discard the preview.
    ctx.putImageData(liveOverlay, 0, 0);
  }

  dragStart = null;
  liveOverlay = null;
}

// We snapshot for undo *before* the stroke, but we only know the stroke
// "happened" once pointerup fires with real movement — so re-derive the
// pre-stroke state from liveOverlay (captured at pointerdown) and push that.
function pushUndoSnapshot_beforeThisStroke() {
  if (undoStack.length >= MAX_UNDO) undoStack.shift();
  undoStack.push(liveOverlay);
  updateUndoBtn();
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

function placeText(point) {
  const text = window.prompt('Text to add:');
  if (!text) return;
  pushUndoSnapshot();
  ctx.save();
  ctx.font = '24px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillStyle = '#dc2626';
  ctx.fillText(text, point.x, point.y);
  ctx.restore();
}

function applyCrop() {
  if (!pendingCropRect || pendingCropRect.w < 2 || pendingCropRect.h < 2) {
    setStatus('Drag a region first.', true);
    return;
  }
  pushUndoSnapshot();
  const { x, y, w, h } = pendingCropRect;
  const cropped = ctx.getImageData(x, y, w, h);
  canvas.width = w;
  canvas.height = h;
  ctx.putImageData(cropped, 0, 0);
  pendingCropRect = null;
  setActiveTool('crop', false); // toggle off
  setStatus('Cropped.');
}

function withWatermark(sourceCanvas) {
  if (isPaid) return sourceCanvas;
  const out = document.createElement('canvas');
  out.width = sourceCanvas.width;
  out.height = sourceCanvas.height;
  const octx = out.getContext('2d');
  octx.drawImage(sourceCanvas, 0, 0);
  const label = 'SnapFull';
  octx.font = `${Math.max(12, Math.round(sourceCanvas.width * 0.015))}px sans-serif`;
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

function canvasToBlob(sourceCanvas, mime, quality) {
  return new Promise((resolve) => sourceCanvas.toBlob(resolve, mime, quality));
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

  const finalCanvas = withWatermark(canvas);
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
    const finalCanvas = withWatermark(canvas);
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

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
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
