import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { AppConfigService } from '../../config/app-config.service';
import type {
  AppSettingView,
  CreateRatingTagDto,
  RatingTagAdminView,
  UpdateRatingTagDto,
} from './dto/platform-config.dto';
import { PlatformConfigRepository } from './platform-config.repository';
import type { RatingTagRecord } from './platform-config.repository';
import { SETTING_DEFINITIONS } from './platform-config.settings';
import type { SettingDefinition } from './platform-config.settings';

export const PlatformConfigErrorCode = {
  SETTING_UNKNOWN: 'SETTING_UNKNOWN',
  SETTING_VALUE_INVALID: 'SETTING_VALUE_INVALID',
  RATING_TAG_EXISTS: 'RATING_TAG_EXISTS',
  RATING_TAG_NOT_FOUND: 'RATING_TAG_NOT_FOUND',
  RATING_TAG_INVALID: 'RATING_TAG_INVALID',
} as const;

export interface ConfigActor {
  userId: string;
  roles: string[];
}

export interface EffectiveAppSettings {
  customerMinVersion: string | null;
  customerStoreUrl: string | null;
  workerMinVersion: string | null;
  workerStoreUrl: string | null;
  maintenance: boolean;
  supportPhone: string | null;
  supportEmail: string | null;
  cancellationPolicyText: string | null;
  cancellationPolicyUrl: string | null;
  refundPolicyText: string | null;
  refundPolicyUrl: string | null;
}

const TAG_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

function parse(definition: SettingDefinition, stored: string): string | boolean {
  return definition.kind === 'boolean' ? stored === 'true' : stored;
}

/**
 * Configuration the business owns and the apps read: the start-up values of GET /app-config and the rating tag catalogue of
 * GET /reference-data. Everything is read from the database on each call (with the environment as the default for settings), so a
 * change by an administrator is visible to the apps at once, with no deployment. With no setting row the apps get the environment
 * default; the tag catalogue starts from the nine tags the migration inserted (D-88) and is edited from there.
 */
@Injectable()
export class PlatformConfigService {
  constructor(
    private readonly repository: PlatformConfigRepository,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  // --- app settings ------------------------------------------------------------------------------------------

  async listSettings(): Promise<AppSettingView[]> {
    const rows = new Map((await this.repository.listSettings()).map((r) => [r.key, r]));
    return SETTING_DEFINITIONS.map((d) => {
      const row = rows.get(d.key);
      const env = d.fromEnv(this.config);
      const value = row ? parse(d, row.value) : (env ?? null);
      return {
        key: d.key,
        kind: d.kind,
        description: d.description,
        value,
        source: row ? 'DATABASE' : env === undefined ? 'UNSET' : 'ENVIRONMENT',
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /** The values the apps receive. */
  async effective(): Promise<EffectiveAppSettings> {
    const out: Record<string, string | boolean | null> = {};
    for (const s of await this.listSettings()) out[s.key] = s.value;
    return { ...(out as unknown as EffectiveAppSettings), maintenance: out.maintenance === true };
  }

  async setSetting(key: string, raw: unknown, admin: ConfigActor): Promise<AppSettingView> {
    const definition = this.definition(key);
    const stored = this.validateValue(definition, raw);
    await this.repository.transaction(async (tx) => {
      await this.repository.upsertSetting(key, stored, admin.userId, tx);
      await this.audit.record(
        {
          action: 'app_setting.set',
          entityType: 'app_setting',
          entityId: key,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          // The contact and policy values are public content, not personal data; only the key is recorded.
          metadata: { key },
        },
        tx,
      );
    });
    return this.view(key);
  }

  async clearSetting(key: string, admin: ConfigActor): Promise<AppSettingView> {
    this.definition(key);
    await this.repository.transaction(async (tx) => {
      if (await this.repository.deleteSetting(key, tx)) {
        await this.audit.record(
          {
            action: 'app_setting.clear',
            entityType: 'app_setting',
            entityId: key,
            actorId: admin.userId,
            actorRole: admin.roles.join(',') || null,
            metadata: { key },
          },
          tx,
        );
      }
    });
    return this.view(key);
  }

  private async view(key: string): Promise<AppSettingView> {
    return (await this.listSettings()).find((s) => s.key === key)!;
  }

  private definition(key: string): SettingDefinition {
    const found = SETTING_DEFINITIONS.find((d) => d.key === key);
    if (!found) {
      throw new DomainException(
        PlatformConfigErrorCode.SETTING_UNKNOWN,
        'This setting does not exist',
        HttpStatus.NOT_FOUND,
      );
    }
    return found;
  }

  private validateValue(definition: SettingDefinition, raw: unknown): string {
    const invalid = (message: string): DomainException =>
      new DomainException(
        PlatformConfigErrorCode.SETTING_VALUE_INVALID,
        message,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    if (definition.kind === 'boolean') {
      if (typeof raw !== 'boolean') throw invalid('Send true or false');
      return String(raw);
    }
    if (typeof raw !== 'string') throw invalid('Send text');
    const value = raw.trim();
    if (value.length === 0) throw invalid('Send a value, or clear the setting to use the default');
    if (value.length > definition.maxLength) {
      throw invalid(`At most ${definition.maxLength} characters`);
    }
    if (definition.pattern && !definition.pattern.regex.test(value)) {
      throw invalid(definition.pattern.message);
    }
    return value;
  }

  // --- rating tags -------------------------------------------------------------------------------------------

  /** The catalogue the rating screen shows: active tags only, in the order staff set. */
  async activeTags(): Promise<Array<{ code: string; label: string; sentiment: string }>> {
    return (await this.repository.listTags(true)).map(({ code, label, sentiment }) => ({
      code,
      label,
      sentiment,
    }));
  }

  /** 422 RATING_TAG_INVALID for any code that is not an active tag. */
  async assertTagsAllowed(codes: string[]): Promise<void> {
    if (codes.length === 0) return;
    const active = new Set((await this.repository.listTags(true)).map((t) => t.code));
    const unknown = codes.filter((c) => !active.has(c));
    if (unknown.length > 0) {
      throw new DomainException(
        PlatformConfigErrorCode.RATING_TAG_INVALID,
        'One or more tags are not available (GET /reference-data ratingTags)',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'tags', messages: unknown.map((c) => `${c} is not an active tag`) }],
      );
    }
  }

  private tagNotFound(): DomainException {
    return new DomainException(
      PlatformConfigErrorCode.RATING_TAG_NOT_FOUND,
      'Tag not found',
      HttpStatus.NOT_FOUND,
    );
  }

  async listTags(): Promise<RatingTagAdminView[]> {
    return (await this.repository.listTags(false)).map(toTagView);
  }

  async createTag(dto: CreateRatingTagDto, admin: ConfigActor): Promise<RatingTagAdminView> {
    try {
      const created = await this.repository.transaction(async (tx) => {
        const tag = await this.repository.createTag(
          {
            code: dto.code,
            label: dto.label,
            sentiment: dto.sentiment,
            sortOrder: dto.sortOrder ?? 0,
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'rating_tag.create',
            entityType: 'rating_tag',
            entityId: tag.code,
            actorId: admin.userId,
            actorRole: admin.roles.join(',') || null,
            metadata: { code: tag.code },
          },
          tx,
        );
        return tag;
      });
      return toTagView(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          PlatformConfigErrorCode.RATING_TAG_EXISTS,
          'A tag with this code already exists',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async updateTag(
    code: string,
    dto: UpdateRatingTagDto,
    admin: ConfigActor,
  ): Promise<RatingTagAdminView> {
    // A code that cannot exist is unknown; it never reaches the database (PostgreSQL rejects NUL bytes in text with a 500).
    if (!TAG_CODE.test(code)) throw this.tagNotFound();
    const changes = Object.entries(dto).filter(([, v]) => v !== undefined);
    if (changes.length === 0) {
      throw new DomainException(ErrorCode.BAD_REQUEST, 'Nothing to change', HttpStatus.BAD_REQUEST);
    }
    const updated = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.findTag(code, tx))) throw this.tagNotFound();
      const tag = await this.repository.updateTag(code, dto, tx);
      await this.audit.record(
        {
          action: 'rating_tag.update',
          entityType: 'rating_tag',
          entityId: code,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { code, fields: changes.map(([k]) => k) },
        },
        tx,
      );
      return tag;
    });
    return toTagView(updated);
  }
}

function toTagView(t: RatingTagRecord): RatingTagAdminView {
  return {
    code: t.code,
    label: t.label,
    sentiment: t.sentiment,
    sortOrder: t.sortOrder,
    isActive: t.isActive,
    updatedAt: t.updatedAt,
  };
}
