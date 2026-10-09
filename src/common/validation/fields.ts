/**
 * Names of the fields present in a partial update (undefined = not sent; null is a deliberate value). Used for audit
 * metadata: values are never audited because they can be personal data.
 */
export function changedFieldNames(input: object): string[] {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
}
