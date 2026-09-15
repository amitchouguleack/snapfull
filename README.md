# SnapFull — Full-Page Screenshot Extension

Local-only, $0/month-infra full-page screenshot extension for Chrome (MV3).
Capture → crop / redact / annotate → export. No cloud, no account, no backend.

**Landing page:** https://claude.ai/artifact/66BdzBEvroVPTKL6txagUf
(private — share it from the page's share menu when you're ready for others to see it)

See the original build plan for full product/architecture rationale. This
README tracks what's actually implemented and what's left.

## Status: Phase 1–4 implemented and self-audited; nothing published yet

| Phase | Status |
|---|---|
| 1 — Core capture engine (scroll controller, offscreen stitcher, DOM-stability wait, canvas-height-ceiling tiling, sticky-header cropping) | **Confirmed working** — tested against a very long real page (Wikipedia's World War II article, multi-part capture) after fixing a canvas-height unit bug and a separate GPU-texture-limit bug in the review preview |
| 2 — Review/export UI (crop, redact, highlight/arrow/text, PNG/JPEG/PDF export, clipboard copy, watermark, multi-part export) | Implemented; export path and the paid/free lock-icon sync confirmed via real-browser testing. Redact/highlight/arrow/crop interactions past the sync fix still worth another manual click-through |
| 3 — Licensing (Gumroad Membership verify, grace-period cache, free-tier daily counter) | **Live** — SnapFull Pro is a real Gumroad Membership product, wired via `GUMROAD_PRODUCT_ID`/`GUMROAD_PRODUCT_URL` in [shared/constants.js](shared/constants.js), verify call confirmed sending `product_id`. Popup, options, and review now all resync live off `chrome.storage.onChanged`, not just the one screen that happened to get tested first |
| 4 — Security + QA pass | **Self-audit complete** (2026-09-15) — full pass against the hard rules, security checklist, and a zero-maintenance risk register below. No violations found; two plan-sync gaps (popup, options) found and fixed. Still not an independent/third-party audit |
| 5 — Store assets + landing page | Landing page done (linked above); store screenshots/listing copy not started |
| 6 — Ship | Not started |

## Before you can actually use this

1. **Load unpacked** in `chrome://extensions` (Developer mode → Load unpacked
   → select this folder). Core capture, the review UI, and paid-plan sync
   have each been confirmed working in a real Chrome session — see the
   status table above for exactly what's been tested and what hasn't.
2. Regenerate proper icons — [icons/](icons/) currently holds programmatically
   generated placeholders, not real brand art.

**Gumroad is live:** SnapFull Pro is a real Gumroad Membership product.
`GUMROAD_PRODUCT_ID` and `GUMROAD_PRODUCT_URL` in
[shared/constants.js](shared/constants.js) are wired to it. License checks
call Gumroad's `/v2/licenses/verify` with `product_id` (the stable internal
identifier), not `product_permalink` — the permalink/URL slug is only used
for the human-facing checkout link on the options page.

## Architecture

```
manifest.json (MV3)
background/capture-orchestrator.js   service worker, orchestration only
offscreen/                           canvas stitching (SW has no DOM)
content-scripts/scroll-controller.js scroll + MutationObserver stability wait
popup/                               capture trigger + free-tier counter
review/                              crop / redact / annotate / export UI
licensing/license.js                 Gumroad verify + grace-period cache
options/                             license key entry
shared/                              constants, filename sanitizer, PDF writer
```

- **Why an Offscreen Document, not the popup, for stitching:** the popup
  closes if the user clicks away, which would kill an in-progress capture if
  stitching happened there. The offscreen document persists independently.
- **Why a hand-rolled PDF writer** ([shared/pdf-export.js](shared/pdf-export.js)):
  MV3's CSP (`script-src 'self'`) and the Chrome Web Store's ban on remotely
  hosted code rule out pulling in a PDF library from a CDN, and bundling one
  wasn't worth it for "wrap N JPEGs, one per page." It hand-writes just enough
  of the PDF object/xref format to embed JPEG (DCTDecode) streams directly.

## Hard-rules audit (2026-09-15)

Re-checked every file against the original build plan's non-negotiables. No violations found.

- [x] **$0/month infra, no backend, no database, no owned API.** Confirmed by
      absence, not just intent: no `package.json`, no `node_modules`, no
      server code, no database client anywhere in the repo.
- [x] **Only outbound call is the Gumroad license verify.** Grepped the whole
      codebase for `fetch(`, `XMLHttpRequest`, and any hardcoded
      `http(s)://` literal — the only hits are `GUMROAD_VERIFY_URL` and
      `GUMROAD_PRODUCT_URL` in [shared/constants.js](shared/constants.js),
      and the single `fetch()` call site is `verifyWithGumroad` in
      [licensing/license.js](licensing/license.js). Nothing else calls out.
- [x] **All state in `chrome.storage.local`.** License cache, usage counter,
      and the in-flight capture handoff (`STORAGE_KEYS`) all live there;
      grepped for `storage.sync` and `localStorage` — neither is used
      anywhere in the extension.
- [x] **Manifest V3, no eval, no remote code, no inline scripts.** Every
      `<script>` tag across all 4 HTML pages loads a local file with
      `type="module"`; grepped for `eval(`, `new Function`, and inline
      `on*=` handlers — zero hits.
- [x] **Minimal permissions, no `<all_urls>` at install.** `permissions` is
      `activeTab, scripting, downloads, offscreen, storage,
      unlimitedStorage` — every one earns its place (unlimitedStorage exists
      because a base64 PNG of a long page can exceed the default 5–10MB
      `storage.local` quota). `<all_urls>` only appears under
      `optional_host_permissions`, and is requested for one origin at a time
      from `popup.js`'s click handler (a real user-gesture context) — never
      declared as a mandatory `host_permissions`, and nothing is granted at
      install. No `web_accessible_resources` and no static `content_scripts`
      either (the capture content script is injected on demand).

## Security checklist (build-plan §5) — self-review status

- [x] CSP: `script-src 'self'; object-src 'self'`. No inline scripts, no
      `eval`, no remote-hosted JS anywhere.
- [x] No analytics/telemetry, no `fetch()` of image data. The only network
      call anywhere in the codebase is the Gumroad license verify in
      [licensing/license.js](licensing/license.js).
- [x] License key stored in `chrome.storage.local` (not `sync`) —
      deliberate choice, documented in code, so a key isn't silently
      propagated to a user's other synced machines.
- [x] Filenames derived from `<title>` are sanitized before reaching
      `chrome.downloads` — see [shared/sanitize.js](shared/sanitize.js)
      (strips path separators, control chars, reserved Windows device names,
      leading dots).
- [x] Redaction destroys pixel data. Re-verified against the current
      two-canvas review architecture specifically (this changed since the
      checklist item was first written): the redact tool's live drag preview
      only ever touches the small, capped-size `display` canvas; the actual
      destructive `fillRect` is applied to the full-resolution `source`
      canvas on pointerup, and every export/copy/undo path reads from
      `source`. There is no code path where a downscaled or pre-redaction
      copy of the pixels reaches a file or the clipboard.
- [x] Plan-gated UI actually reflects the real license state everywhere it's
      shown, not just where it was first tested — see the consistency check
      below. (Found and fixed as part of this audit: `popup.js` and
      `options.js` had no `chrome.storage.onChanged` listener, so either
      could show stale Free/Paid state if the license changed in another
      tab while they stayed open.)
- [ ] **Not yet done:** a real pass right before Chrome Web Store submission
      re-checking permissions are still minimal, and manual pixel-level QA
      of the redact tool (zoom into an exported PNG and confirm no residual
      data under a redacted box) — the code-level guarantee above hasn't yet
      been checked by eye against an actual exported file.

## Consistency check — Gumroad references & plan-status sync (2026-09-15)

- Grepped for `GUMROAD_PRODUCT_ID`, `GUMROAD_PRODUCT_URL`, and any leftover
  `product_permalink`/old-permalink references. Exactly two usage sites, both
  correct: `license.js` sends `product_id` in the verify request body;
  `options.js` points the buy link straight at `GUMROAD_PRODUCT_URL`. No
  stray references to the retired `GUMROAD_PRODUCT_PERMALINK` constant
  anywhere in code.
- `chrome.storage.onChanged` on the license-cache key is now wired into all
  three screens that show plan-gated state: `review.js` (lock icons, fixed
  earlier), and as of this audit `popup.js` (Free/Paid badge + capture-button
  gating) and `options.js` (plan-status text) as well — previously only
  review.js had it.

## Zero-maintenance risk register (2026-09-15)

Nothing below requires action now — this is a list of everything that
*could* eventually need you to intervene, so it's written down instead of
discovered later. Ranked roughly by how likely/soon each one is to bite.

| Risk | Likelihood / timeframe | Why it could bite |
|---|---|---|
| **Very long pages could exceed the MV3 service worker's idle lifetime.** A capture is many rounds of scroll → stability-wait → throttled `captureVisibleTab`; on an extremely long page (tens of tiles) this can run well past a minute. Chrome generally keeps a service worker alive while it has in-flight extension API calls, but this is exactly the kind of MV3 lifecycle behavior Chrome has tightened before and could tighten again. | Low-medium likelihood; would show up as captures silently failing partway through on unusually long pages, worse after some future Chrome update | No retry/resume logic exists today — a killed service worker mid-capture just loses the in-progress capture. Worth revisiting if you ever see partial-capture reports on very long pages. |
| **`chrome.tabs.captureVisibleTab`'s per-second quota is an internal Chrome constant, not a documented stable API contract.** `CAPTURE_THROTTLE_MS` (500ms) was tuned empirically against the quota error you hit. | Low likelihood, no fixed timeframe | If Chrome ever tightens the real quota, capture would start throwing the same `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` error again with no adaptive backoff — only a manual constant bump would fix it. |
| **Gumroad's `/v2/licenses/verify` response shape isn't contractually pinned.** `verifyWithGumroad` reads `json.success`, `purchase.refunded`, `purchase.chargebacked`, `purchase.subscription_cancelled_at`. | Low likelihood — this API has been stable for years — but no fixed timeframe | A field rename on Gumroad's end would silently misclassify paid users as free (annoying, but the 7-day grace period softens it) or, worse, the reverse. Nothing would alert you to this except a user complaint, since there's deliberately no telemetry. |
| **No crash/error visibility by design.** The privacy stance (no telemetry, ever) means if a future Chrome update breaks capture or licensing for everyone, you will not know unless a user emails you. | Certain to eventually matter, timeframe unknown | This is the direct tradeoff of the "zero telemetry" hard rule — flagging it so it's a known, accepted tradeoff rather than a surprise. The Gumroad dashboard is the only other passive signal you'd have (e.g. verify-call volume dropping unexpectedly). |
| **`MAX_CANVAS_HEIGHT` (32,000) and `MAX_DISPLAY_DIMENSION` (4,096) encode undocumented, empirically-derived browser/GPU limits**, not values Chrome guarantees in writing. | Very low likelihood; these limits only ever get more permissive over time in practice | If a future Chrome/GPU driver combination has a *lower* real ceiling than assumed, the same class of corruption this audit's predecessor commits fixed could reappear in a new edge case. No monitoring possible for this short of periodic manual testing on very long pages. |
| **Publishing to the Chrome Web Store is itself an ongoing commitment, not a one-time step.** Every future update needs to clear CWS review; Google's Developer Program Policies change periodically and could someday require new privacy disclosures even for an already-minimal permission set. | Certain once published, low frequency | Not a code risk, a process one — budget review-turnaround time into any future update, especially a manifest/permissions change. |
| **Hardcoded Gumroad identifiers go stale if the Gumroad account ever changes.** `GUMROAD_PRODUCT_ID` and `GUMROAD_PRODUCT_URL` are fixed strings in [shared/constants.js](shared/constants.js). | Only if you personally change Gumroad accounts/products | Expected manual update, not automatic breakage — noted so it's not forgotten if that ever happens. |
| **Zero dependencies is a real strength here, not a gap.** No `package.json`, no bundler, no npm packages anywhere — confirmed during this audit. | N/A | Nothing to patch for CVEs, nothing to go stale across a Node/npm version change, nothing to re-audit transitively. Worth keeping this way. |

## Known gaps / things to verify by hand before shipping

- Sticky/fixed header detection ([content-scripts/scroll-controller.js](content-scripts/scroll-controller.js))
  walks up to 2000 DOM nodes near the viewport top and takes the tallest
  fixed/sticky match — this is a heuristic, not exhaustive; test against a
  real sticky-header site.
- No automated tests exist yet. Phase 1's "5 real test sites" QA pass
  (long blog post, lazy-load feed, SPA, very tall doc, sticky-header page)
  has not been run.
- `manifest.json`'s `minimum_chrome_version: "116"` matches the
  `chrome.runtime.getContexts` call used to avoid creating duplicate
  offscreen documents — don't lower it without checking that API's
  availability.
