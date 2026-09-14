// Sanitizes a page title into a safe filename fragment before it's ever handed
// to chrome.downloads. A crafted <title> must never be able to escape the
// intended download directory or inject control characters into the path.

/**
 * @param {string} rawTitle
 * @returns {string} a filesystem-safe, length-capped filename fragment
 */
export function sanitizeFilename(rawTitle) {
  const fallback = 'snapfull-capture';
  if (!rawTitle || typeof rawTitle !== 'string') return fallback;

  let name = rawTitle
    // Strip any path separators (forward/back slash) so nothing can traverse
    // out of the downloads root that chrome.downloads.download writes into.
    .replace(/[\\/]+/g, '-')
    // Strip Windows-reserved and otherwise unsafe filename characters.
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    // Strip leading dots/dashes so it can't resolve to "." or ".." segments
    // or be mistaken for a CLI flag by any downstream tool.
    .replace(/^[.\-\s]+/, '')
    .trim();

  // Collapse whitespace runs to single spaces, then to dashes for a clean name.
  name = name.replace(/\s+/g, ' ').replace(/ /g, '-');

  // Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    name = fallback;
  }

  if (!name) name = fallback;

  // Cap length well under filesystem limits, leaving room for a suffix/extension.
  return name.slice(0, 100);
}
