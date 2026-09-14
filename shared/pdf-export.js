// Minimal, dependency-free PDF writer. MV3's CSP ('self') and the Chrome Web
// Store's ban on remotely-hosted code mean we can't pull in a PDF library —
// so this hand-rolls just enough of the PDF spec to wrap one JPEG per page,
// which is all a multi-part screenshot export needs.

/**
 * @param {{ jpegBytes: Uint8Array, widthPx: number, heightPx: number }[]} pages
 * @returns {Blob} application/pdf
 */
export function buildPdfFromJpegPages(pages) {
  const chunks = [];
  const offsets = [];
  let byteLength = 0;

  function push(strOrBytes) {
    const bytes = typeof strOrBytes === 'string' ? textToBytes(strOrBytes) : strOrBytes;
    chunks.push(bytes);
    byteLength += bytes.length;
  }

  function beginObj(num) {
    offsets[num] = byteLength;
    push(`${num} 0 obj\n`);
  }

  push('%PDF-1.4\n');

  // Object numbering: 1 = Catalog, 2 = Pages, then per page: page obj, image
  // obj, content-stream obj (3 objects per page, starting at 3).
  const objectsPerPage = 3;
  const totalObjects = 2 + pages.length * objectsPerPage;
  const pageObjNums = pages.map((_, i) => 3 + i * objectsPerPage);
  const imgObjNums = pages.map((_, i) => 4 + i * objectsPerPage);
  const contentObjNums = pages.map((_, i) => 5 + i * objectsPerPage);

  beginObj(1);
  push(`<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

  beginObj(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] >>\nendobj\n`);

  pages.forEach((page, i) => {
    const { jpegBytes, widthPx, heightPx } = page;

    beginObj(pageObjNums[i]);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPx} ${heightPx}] ` +
      `/Resources << /XObject << /Im0 ${imgObjNums[i]} 0 R >> >> /Contents ${contentObjNums[i]} 0 R >>\nendobj\n`
    );

    beginObj(imgObjNums[i]);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
    );
    push(jpegBytes);
    push(`\nendstream\nendobj\n`);

    const content = `q ${widthPx} 0 0 ${heightPx} 0 0 cm /Im0 Do Q`;
    beginObj(contentObjNums[i]);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const xrefStart = byteLength;
  push(`xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= totalObjects; n++) {
    push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  return new Blob(chunks, { type: 'application/pdf' });
}

function textToBytes(str) {
  // PDF structural text is plain ASCII/Latin-1 — no UTF-8 multibyte needed here.
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}
