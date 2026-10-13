import { Controller, Get } from '@nestjs/common';
import { ApiModelResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { WorkersService } from '../workers/workers.service';
import { VerificationService } from './verification.service';

export const ONBOARDING_STEPS = [
  'PROFILE',
  'WORK',
  'AVAILABILITY',
  'PHOTO',
  'SUBMIT',
  'DOCUMENTS',
  'VERIFICATION',
] as const;
type StepKey = (typeof ONBOARDING_STEPS)[number];

/** Which field reported missing by the profile belongs to which step (stable names, see GET /workers/me). */
const STEP_OF_MISSING: Record<string, StepKey> = {
  address: 'PROFILE',
  emergencyContact: 'PROFILE',
  categories: 'WORK',
  languages: 'WORK',
  experience: 'WORK',
  engagementPreference: 'AVAILABILITY',
  areas: 'AVAILABILITY',
  timeWindows: 'AVAILABILITY',
};

const LABELS: Record<StepKey, string> = {
  PROFILE: 'Personal details',
  WORK: 'Work details',
  AVAILABILITY: 'Where and when',
  PHOTO: 'Photo',
  SUBMIT: 'Submit',
  DOCUMENTS: 'Documents',
  VERIFICATION: 'Verification',
};

export class OnboardingStepView {
  @ApiProperty({ enum: ONBOARDING_STEPS }) key!: StepKey;
  @ApiProperty() label!: string;
  @ApiProperty() done!: boolean;
  @ApiProperty({
    description:
      'false = optional: the step never decides nextStep (a photo is not required to submit; whether it must be is undecided).',
  })
  required!: boolean;
  @ApiProperty({
    type: [String],
    description: 'What is still missing in this step (stable field names).',
  })
  missing!: string[];
}

export class WorkerOnboardingView {
  @ApiProperty({ enum: ['DRAFT', 'SUBMITTED'] }) profileStatus!: string;
  @ApiProperty({ enum: ['NOT_STARTED', 'IN_PROGRESS', 'VERIFIED'] }) verificationLevel!: string;
  @ApiProperty({ type: [OnboardingStepView] }) steps!: OnboardingStepView[];
  @ApiProperty({
    nullable: true,
    enum: ONBOARDING_STEPS,
    description: 'The first required step that is not done.',
  })
  nextStep!: StepKey | null;
  @ApiProperty({
    description:
      'The profile is submitted AND every required check is approved: customers can find the worker.',
  })
  canReceiveJobs!: boolean;
  @ApiProperty({ type: [String], description: 'Checks that were rejected and need a new upload.' })
  actionRequired!: string[];
}

/**
 * Where the worker is in onboarding, in one call: the app shows it after every restart or new sign-in and decides which screen comes
 * next. It only reads; every step is saved by its own endpoint (profile, categories, availability, photo, submit, documents).
 */
@ApiTags('Worker onboarding')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/onboarding', version: '1' })
export class WorkerOnboardingController {
  constructor(
    private readonly workers: WorkersService,
    private readonly verification: VerificationService,
  ) {}

  @Get()
  @ApiModelResponse(WorkerOnboardingView)
  @ApiOperation({
    summary:
      'My onboarding progress: steps, what is missing in each, the next step and verification state',
    description:
      'Steps in order: PROFILE (address, emergency contact) -> WORK (roles, languages, experience) -> AVAILABILITY (engagement preference, areas, time windows) -> PHOTO (optional) -> SUBMIT (the profile) -> DOCUMENTS (the required checks; the server accepts uploads only after the profile is submitted) -> VERIFICATION (staff approval). 404 until the profile is created (POST /workers/me).',
  })
  async get(@CurrentUser() user: AuthenticatedUser): Promise<WorkerOnboardingView> {
    const [profile, checks] = await Promise.all([
      this.workers.getMyProfile(user.userId),
      this.verification.getMine(user.userId),
    ]);
    const missingBy = new Map<StepKey, string[]>();
    for (const field of profile.missingForSubmission) {
      const step = STEP_OF_MISSING[field];
      if (step) missingBy.set(step, [...(missingBy.get(step) ?? []), field]);
    }
    const submitted = profile.onboardingStatus === 'SUBMITTED';
    const required = checks.checks.filter((c) => c.required);
    const documentsDone =
      submitted &&
      required.length > 0 &&
      required.every((c) =>
        ['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'RECHECK_DUE'].includes(c.status),
      );
    const rejected = required.filter((c) => c.status === 'REJECTED').map((c) => c.checkType);
    const done: Record<StepKey, boolean> = {
      PROFILE: submitted || !missingBy.has('PROFILE'),
      WORK: submitted || !missingBy.has('WORK'),
      AVAILABILITY: submitted || !missingBy.has('AVAILABILITY'),
      PHOTO: profile.hasProfilePhoto,
      SUBMIT: submitted,
      DOCUMENTS: documentsDone,
      VERIFICATION: checks.level === 'VERIFIED',
    };
    const missingOf = (key: StepKey): string[] => {
      if (done[key]) return [];
      if (key === 'PHOTO') return ['photo'];
      if (key === 'DOCUMENTS') {
        return submitted
          ? required
              .filter((c) => c.status === 'NOT_SUBMITTED' || c.status === 'REJECTED')
              .map((c) => c.checkType)
          : [];
      }
      return missingBy.get(key) ?? [];
    };
    const steps: OnboardingStepView[] = ONBOARDING_STEPS.map((key) => ({
      key,
      label: LABELS[key],
      done: done[key],
      required: key !== 'PHOTO',
      missing: missingOf(key),
    }));
    const next = steps.find((s) => s.required && !s.done);
    return {
      profileStatus: profile.onboardingStatus,
      verificationLevel: checks.level,
      steps,
      nextStep: next ? next.key : null,
      canReceiveJobs: submitted && checks.level === 'VERIFIED',
      actionRequired: rejected,
    };
  }
}
