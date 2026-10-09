/** Engagement values the Availability module stores (Q-38: customer-side daily/hourly are not modelled). */
export const ENGAGEMENTS = ['FULL_TIME', 'PART_TIME', 'LIVE_IN'] as const;
export type Engagement = (typeof ENGAGEMENTS)[number];

/**
 * What an eligible worker must satisfy. Category and area are resolved to ids by the caller (and so are already known to be
 * enabled); everything optional is simply not filtered on when absent.
 */
export interface EligibleWorkerCriteria {
  categoryId: string;
  areaId: string;
  /** Restricts the question to one worker: "is this worker eligible for the requirement?" (Booking). */
  workerId?: string;
  /** Leaves one worker out (the worker being replaced). */
  excludeWorkerId?: string;
  engagement?: Engagement;
  /** Minutes after local midnight; both or neither. A worker matches when ONE of their windows covers [from, to]. */
  window?: { fromMinute: number; toMinute: number };
  language?: string;
  minExperienceMonths?: number;
}

/**
 * Orderings are stable (the id breaks every tie). None of them is a relevance score: no ranking is defined by the specs (Q-46).
 */
export type EligibleOrder = 'EXPERIENCE_DESC' | 'EXPERIENCE_ASC' | 'SUBMITTED_ASC';

export interface EligibleWorker {
  id: string;
  userId: string;
  name: string;
  experienceMonths: number | null;
  engagementPreference: Engagement | null;
  categories: Array<{ code: string; name: string }>;
  languages: string[];
  serviceAreas: Array<{ id: string; name: string; city: string }>;
  availability: Array<{ startMinute: number; endMinute: number }>;
}
