// Hidden diagnostics tab. Reads only chrome.storage.local via
// collectDiagnostics() (shared/diagnostics.js) — no network call anywhere on
// this page, and "Copy Report" only ever writes to the clipboard. Nothing
// here is sent anywhere automatically.

import { collectDiagnostics, formatDiagnosticsReport } from '../shared/diagnostics.js';

const overviewList = document.getElementById('overview-list');
const captureList = document.getElementById('capture-list');
const errorList = document.getElementById('error-list');
const copyBtn = document.getElementById('copy-btn');
const copyMsg = document.getElementById('copy-msg');

function kv(term, value) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  return [dt, dd];
}

function renderOverview(data) {
  overviewList.innerHTML = '';
  const rows = [
    ['Extension version', data.extensionVersion],
    ['Chrome version', data.chromeVersion],
    ['Plan status', data.plan.status],
    ['Plan last checked', `${data.plan.lastChecked} (${data.plan.source})`],
  ];
  for (const [term, value] of rows) {
    const [dt, dd] = kv(term, value);
    overviewList.append(dt, dd);
  }
}

function emptyItem(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function renderCaptures(captures) {
  captureList.innerHTML = '';
  if (captures.length === 0) {
    captureList.append(emptyItem('No captures recorded yet.'));
    return;
  }
  for (const c of captures) {
    const li = document.createElement('li');
    const ts = document.createElement('span');
    ts.className = 'entry-ts';
    ts.textContent = c.tsLabel;
    const body = document.createElement('div');
    if (c.ok) {
      // Built with the DOM API rather than innerHTML, like everything else
      // in this file — tileCount is always an internally-generated number
      // (never page content), but there's no reason for this one line to be
      // the exception to how the rest of the panel stays injection-proof.
      const status = document.createElement('span');
      status.className = 'entry-ok';
      status.textContent = 'Success';
      body.append(status, document.createTextNode(` — ${c.tileCount ?? '?'} piece(s)`));
    } else {
      const status = document.createElement('span');
      status.className = 'entry-fail';
      status.textContent = 'Failed';
      body.append(status, document.createTextNode(' — ' + (c.plain || c.error || 'unknown reason')));
    }
    li.append(ts, body);
    captureList.append(li);
  }
}

function renderErrors(errors) {
  errorList.innerHTML = '';
  if (errors.length === 0) {
    errorList.append(emptyItem('Nothing has errored recently.'));
    return;
  }
  for (const e of errors) {
    const li = document.createElement('li');
    const ts = document.createElement('span');
    ts.className = 'entry-ts';
    ts.textContent = `${e.tsLabel} · ${e.component}`;
    const body = document.createElement('div');
    body.textContent = e.plain;
    li.append(ts, body);
    errorList.append(li);
  }
}

async function render() {
  const data = await collectDiagnostics();
  renderOverview(data);
  renderCaptures(data.captures);
  renderErrors(data.errors);
  return data;
}

let latestData = null;

copyBtn.addEventListener('click', async () => {
  try {
    const data = latestData || (await render());
    const report = formatDiagnosticsReport(data);
    await navigator.clipboard.writeText(report);
    copyMsg.textContent = 'Copied to clipboard.';
  } catch (err) {
    copyMsg.textContent = 'Could not copy: ' + String(err && err.message || err);
  }
});

render().then((data) => { latestData = data; });
