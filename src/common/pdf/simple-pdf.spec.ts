import { buildTextPdf } from './simple-pdf';

describe('buildTextPdf', () => {
  it('builds a PDF whose cross-reference offsets point at each object', () => {
    const pdf = buildTextPdf(
      [{ text: 'Payment receipt', bold: true, size: 18 }, { text: 'Amount: INR 500.00' }],
      'Receipt',
    );
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const offsets = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(offsets).toHaveLength(7);
    offsets.forEach((offset, i) => expect(text.slice(offset, offset + 8)).toBe(`${i + 1} 0 obj\n`));
    expect(text).toContain('(Amount: INR 500.00) Tj');
  });

  it('escapes PDF string delimiters and replaces non-ASCII text', () => {
    const text = buildTextPdf([{ text: 'a (b) \\ c ₹' }]).toString('latin1');
    expect(text).toContain('(a \\(b\\) \\\\ c ?) Tj');
  });
});
