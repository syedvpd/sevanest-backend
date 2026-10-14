/**
 * A one-page PDF of plain text lines, built by hand (no dependency). Standard Helvetica fonts only, so text is limited to
 * printable ASCII; anything else becomes "?". Enough for a receipt; not a layout engine.
 */
export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Extra space above this line, in points. */
  gapBefore?: number;
}

const PAGE_WIDTH = 595; // A4 in points
const PAGE_HEIGHT = 842;
const MARGIN = 56;

const ascii = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');
const escape = (text: string): string => ascii(text).replace(/[\\()]/g, (c) => `\\${c}`);

export function buildTextPdf(lines: PdfLine[], title = 'Document'): Buffer {
  let y = PAGE_HEIGHT - MARGIN;
  const ops: string[] = [];
  for (const line of lines) {
    const size = line.size ?? 11;
    y -= (line.gapBefore ?? 0) + size * 1.45;
    if (y < MARGIN) break;
    ops.push(
      `BT /${line.bold ? 'F2' : 'F1'} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td (${escape(line.text)}) Tj ET`,
    );
  }
  const content = ops.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${escape(title)}) /Producer (SevaNest) >>`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
