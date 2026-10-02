/**
 * QR code → SVG for the `claude-usage pair` page (§23.48). CLI-only: the matrix code is the
 * vendored copy under `vendor/qrcode/` and is never in the daemon's import graph.
 */
import QRCode from '../../vendor/qrcode/index.cjs';
import QRErrorCorrectLevel from '../../vendor/qrcode/QRErrorCorrectLevel.cjs';

/** Modules of quiet zone around the code, as the QR spec asks. */
const QUIET_ZONE = 4;

/** `matrix[row][col]` is true for a dark module. Error correction M survives a glossy screen. */
export function qrMatrix(text: string): boolean[][] {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** A self-contained SVG: one path of unit squares on a white square, crisp at any size. */
export function qrSvg(text: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length + QUIET_ZONE * 2;
  let d = '';
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) d += `M${String(c + QUIET_ZONE)} ${String(r + QUIET_ZONE)}h1v1h-1z`;
    });
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(size)} ${String(size)}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">` +
    `<rect width="${String(size)}" height="${String(size)}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}
