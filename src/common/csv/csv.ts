/** One CSV cell: quoted when needed, and prefixed so a spreadsheet never evaluates it as a formula. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

type Scalar = string | number | boolean | null | undefined;
const isScalar = (v: unknown): v is Scalar =>
  v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

/**
 * Flattens a report payload into rows: an array is the rows; otherwise the first array property (series, items, ...) is the rows
 * and the payload's own scalar fields are repeated on none of them; a payload with no array becomes one row of its scalar fields.
 * Nested objects are written as `parent.child` columns. Never throws on an unexpected shape.
 */
export function reportRows(data: unknown): Array<Record<string, Scalar>> {
  const flatten = (value: unknown, prefix = ''): Record<string, Scalar> => {
    const out: Record<string, Scalar> = {};
    if (isScalar(value)) return prefix ? { [prefix]: value } : {};
    if (Array.isArray(value)) return out;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (isScalar(inner)) out[name] = inner;
      else if (!Array.isArray(inner)) Object.assign(out, flatten(inner, name));
    }
    return out;
  };
  if (Array.isArray(data)) return data.map((row) => flatten(row));
  if (data && typeof data === 'object') {
    const list = Object.values(data).find(Array.isArray) as unknown[] | undefined;
    if (list) return list.map((row) => flatten(row));
    return [flatten(data)];
  }
  return [];
}

export function toCsv(rows: Array<Record<string, Scalar>>): string {
  const columns: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const lines = [columns.map((c) => csvCell(c)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
