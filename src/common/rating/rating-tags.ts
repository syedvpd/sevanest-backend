/**
 * Fixed rating tag catalogue (Q-103, proposed by the customer-app team; NOT yet confirmed by the client). Stored and exchanged as
 * stable machine codes; the labels are display text for GET /reference-data. Which tags go with which score is deliberately not
 * enforced: that rule is not approved, so any catalogue tag is accepted with any score.
 */
export const RATING_TAGS = [
  { code: 'PUNCTUAL', label: 'Punctual', sentiment: 'POSITIVE' },
  { code: 'POLITE', label: 'Polite', sentiment: 'POSITIVE' },
  { code: 'SKILLED', label: 'Skilled', sentiment: 'POSITIVE' },
  { code: 'CLEAN_WORK', label: 'Clean work', sentiment: 'POSITIVE' },
  { code: 'TRUSTWORTHY', label: 'Trustworthy', sentiment: 'POSITIVE' },
  { code: 'LATE', label: 'Late', sentiment: 'NEGATIVE' },
  { code: 'RUDE', label: 'Rude', sentiment: 'NEGATIVE' },
  { code: 'POOR_QUALITY_WORK', label: 'Poor quality work', sentiment: 'NEGATIVE' },
  { code: 'UNRELIABLE', label: 'Unreliable', sentiment: 'NEGATIVE' },
] as const;

export type RatingTagCode = (typeof RATING_TAGS)[number]['code'];
export const RATING_TAG_CODES = RATING_TAGS.map<RatingTagCode>((t) => t.code);
