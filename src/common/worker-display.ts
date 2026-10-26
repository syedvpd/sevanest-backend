/**
 * Customer-facing worker name (D-81, D-91): first name and last initial ("Lakshmi D."), never the full name. One place, so the
 * cards, profile, shortlist, bookings and interviews all show the same text.
 */
export function workerDisplay(fullName: string): { displayName: string; initials: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const lastInitial = last ? Array.from(last)[0].toUpperCase() : '';
  return {
    displayName: lastInitial ? `${first} ${lastInitial}.` : first,
    initials: (Array.from(first)[0] ?? '').toUpperCase() + lastInitial,
  };
}
