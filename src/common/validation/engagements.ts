/** Engagement types the platform knows (PRD 4). Shared vocabulary for categories, availability, search and booking. */
export const ENGAGEMENTS = [
  'FULL_TIME',
  'PART_TIME',
  'LIVE_IN',
  'DAILY',
  'HOURLY',
  'SHIFT',
  'ONE_TIME',
] as const;
export type Engagement = (typeof ENGAGEMENTS)[number];
