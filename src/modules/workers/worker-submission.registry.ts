import { Injectable } from '@nestjs/common';

/** A requirement owned by ANOTHER module that must hold before a worker profile can be submitted. */
export interface SubmissionCheck {
  /** Returns stable machine names of what is still missing for this worker (empty = satisfied). */
  missingFor(workerId: string): Promise<string[]>;
}

/**
 * Lets modules that depend on Workers (Availability) contribute submission requirements without Workers importing them.
 * Same one-way-dependency pattern as Users' events: dependents register themselves at startup.
 */
@Injectable()
export class WorkerSubmissionRegistry {
  private readonly checks: SubmissionCheck[] = [];

  register(check: SubmissionCheck): void {
    this.checks.push(check);
  }

  async missingFor(workerId: string): Promise<string[]> {
    const results = await Promise.all(this.checks.map((check) => check.missingFor(workerId)));
    return results.flat();
  }
}
