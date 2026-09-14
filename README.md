# SnapFull — Full-Page Screenshot Extension

Local-only, $0/month-infra full-page screenshot extension for Chrome (MV3).
Capture → crop / redact / annotate → export. No cloud, no account, no backend.

See the original build plan for full product/architecture rationale. This
README tracks what's actually implemented and what's left.

## Status: Phase 1–2 scaffolded (unreviewed, untested in a real browser yet)

| Phase | Status |
|---|---|
| 1 — Core capture engine (scroll controller, offscreen stitcher, DOM-stability wait, canvas-height-ceiling tiling, sticky-header cropping) | Implemented, **not yet tested against real pages** |
| 2 — Review/export UI (crop, redact, highlight/arrow/text, PNG/JPEG/PDF export, clipboard copy, watermark, multi-part export) | Implemented, **not yet tested** |
| 3 — Licensing (Gumroad Membership verify, grace-period cache, free-tier daily counter) | Implemented, **needs a real Gumroad product + permalink** |
| 4 — Security + QA pass | Partially self-reviewed, see checklist below — needs a real audit pass |
| 5 — Store assets + landing page | Not started |
| 6 — Ship | Not started |

## Before you can actually use this

1. **Load unpacked** in `chrome://extensions` (Developer mode → Load unpacked
   → select this folder) and test the capture flow against real pages —
   nothing in here has been run in an actual browser yet.
2. Create a **Gumroad Membership product**, then replace
   `GUMROAD_PRODUCT_PERMALINK` in [shared/constants.js](shared/constants.js)
   with your real permalink.
3. Regenerate proper icons — [icons/](icons/) currently holds programmatically
   generated placeholders, not real brand art.

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

## Security checklist (build-plan §5) — self-review status

- [x] Manifest permissions: only `activeTab`, `scripting`, `downloads`,
      `offscreen`, `storage`, `unlimitedStorage`. `<all_urls>` is
      `optional_host_permissions` only, requested per-origin at first capture
      via `chrome.permissions.request` (see `ensureHostPermission` in
      [background/capture-orchestrator.js](background/capture-orchestrator.js)) — never granted at install.
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
- [x] Redaction destroys pixel data: the redact tool paints directly onto the
      capture canvas during the drag and the result is baked in before
      pointerup — there's no separate reveal/overlay layer sitting on top of
      intact original pixels.
- [ ] **Not yet done:** a real pass right before Chrome Web Store submission
      re-checking permissions are still minimal, and manual QA of the redact
      tool against actual pixel inspection (zoom into an exported PNG and
      confirm no residual data under a redacted box).

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
