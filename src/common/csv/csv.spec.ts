import { csvCell, reportRows, toCsv } from './csv';

describe('csv', () => {
  it('quotes cells that need it and neutralises anything a spreadsheet could run as a formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    for (const danger of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx']) {
      expect(csvCell(danger).startsWith("'")).toBe(true);
    }
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(false)).toBe('false');
  });

  it('finds the rows of every report shape without throwing', () => {
    expect(reportRows([{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
    expect(reportRows({ total: 3, series: [{ day: 'x', count: 3 }] })).toEqual([
      { day: 'x', count: 3 },
    ]);
    expect(reportRows({ workers: 4, nested: { rate: 0.5 } })).toEqual([
      { workers: 4, 'nested.rate': 0.5 },
    ]);
    expect(reportRows(null)).toEqual([]);
    expect(reportRows('text')).toEqual([]);
  });

  it('writes a header from every column that appears and keeps rows aligned', () => {
    const csv = toCsv([{ a: 1 }, { a: 2, b: '=bad' }]);
    expect(csv).toBe("a,b\r\n1,\r\n2,'=bad\r\n");
  });
});
