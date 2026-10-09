import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, PageQueryDto, skipFor } from '../../common/pagination/pagination';
import { maskMobile, normalizeIndianMobile } from '../../common/validation/indian-mobile';
import { assertLanguageSupported } from '../../common/validation/language';
import { AppConfigService } from '../../config/app-config.service';
import type { CustomerVerificationStatus } from '../../generated/prisma/client';
import { UsersService } from '../users/users.service';
import type { Actor, UserRecord } from '../users/users.types';
import { CustomersRepository, NoteRecord, ProfileRecord } from './customers.repository';
import {
  AdminCustomerDetail,
  AdminCustomerListQuery,
  AdminCustomerSummary,
  CreateCustomerProfileDto,
  CustomerNoteResponse,
  CustomerProfileResponse,
  UpdateCustomerProfileDto,
} from './dto/customers.dto';
import { changedFieldNames } from '../../common/validation/fields';
import { toAdminAddressView } from './customer-addresses.service';

export const CustomersErrorCode = {
  CUSTOMER_PROFILE_EXISTS: 'CUSTOMER_PROFILE_EXISTS',
  CUSTOMER_PROFILE_NOT_FOUND: 'CUSTOMER_PROFILE_NOT_FOUND',
  CUSTOMER_PROFILE_REQUIRED: 'CUSTOMER_PROFILE_REQUIRED',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
} as const;

function toProfileView(profile: ProfileRecord, user: UserRecord | null): CustomerProfileResponse {
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    preferredLanguage: profile.preferredLanguage,
    mobile: user?.mobile ?? '',
    verificationStatus: profile.verificationStatus,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/**
 * Customer profile (FR-CUS-003/004/006) and the admin customer-management use cases (FRD FM-02: view status, add notes,
 * change status). Suspension is NOT here: it is the account status owned by Users. Profile verification starts PENDING
 * and changes only by an authorised admin, because the rule that promotes PENDING to VERIFIED is an open decision.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly repository: CustomersRepository,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  // --- the customer's own profile ---------------------------------------------------------------------------

  async createMyProfile(
    userId: string,
    dto: CreateCustomerProfileDto,
  ): Promise<CustomerProfileResponse> {
    assertLanguageSupported(dto.preferredLanguage, this.config.supportedLanguages);
    try {
      const profile = await this.repository.transaction(async (tx) => {
        const created = await this.repository.createProfile({ userId, ...dto }, tx);
        await this.audit.record(
          {
            action: 'customer.profile_create',
            entityType: 'customer_profile',
            entityId: created.id,
            actorId: userId,
            metadata: { verificationStatus: created.verificationStatus },
          },
          tx,
        );
        return created;
      });
      return toProfileView(profile, await this.users.findById(userId));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          CustomersErrorCode.CUSTOMER_PROFILE_EXISTS,
          'A profile already exists for this account',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async getMyProfile(userId: string): Promise<CustomerProfileResponse> {
    const [profile, user] = await Promise.all([
      this.repository.findProfileByUserId(userId),
      this.users.findById(userId),
    ]);
    if (!profile) {
      throw this.profileNotFound();
    }
    return toProfileView(profile, user);
  }

  async updateMyProfile(
    userId: string,
    dto: UpdateCustomerProfileDto,
  ): Promise<CustomerProfileResponse> {
    const fields = changedFieldNames(dto);
    if (fields.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'body', messages: ['at least one field must be provided'] }],
      );
    }
    if (dto.preferredLanguage !== undefined) {
      assertLanguageSupported(dto.preferredLanguage, this.config.supportedLanguages);
    }
    const profile = await this.repository.transaction(async (tx) => {
      const existing = await this.repository.findProfileByUserId(userId, tx);
      if (!existing) {
        throw this.profileNotFound();
      }
      const updated = await this.repository.updateProfile(
        existing.id,
        { name: dto.name, email: dto.email, preferredLanguage: dto.preferredLanguage },
        tx,
      );
      // Field NAMES only: the values are personal data and never go to the audit log.
      await this.audit.record(
        {
          action: 'customer.profile_update',
          entityType: 'customer_profile',
          entityId: existing.id,
          actorId: userId,
          metadata: { changedFields: fields },
        },
        tx,
      );
      return updated;
    });
    return toProfileView(profile, await this.users.findById(userId));
  }

  // --- admin customer management ----------------------------------------------------------------------------

  async adminList(query: AdminCustomerListQuery): Promise<Page<AdminCustomerSummary>> {
    let userId: string | undefined;
    if (query.mobile !== undefined) {
      const normalized = normalizeIndianMobile(query.mobile);
      const user = normalized ? await this.users.findByMobile(normalized) : null;
      if (!user) {
        return { data: [], meta: { page: query.page, limit: query.limit, total: 0 } };
      }
      userId = user.id;
    }
    const { items, total } = await this.repository.listProfiles(
      { verificationStatus: query.verificationStatus, userId },
      skipFor(query),
      query.limit,
    );
    const users = new Map(
      (await this.users.findManyByIds(items.map((p) => p.userId))).map((u) => [u.id, u]),
    );
    return {
      data: items.map((profile) =>
        this.toSummary(profile, users.get(profile.userId) ?? null, true),
      ),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(customerId: string): Promise<AdminCustomerDetail> {
    const profile = await this.requireCustomer(customerId);
    const [user, addresses] = await Promise.all([
      this.users.findById(profile.userId),
      this.repository.listAllAddresses(profile.id),
    ]);
    return {
      ...this.toSummary(profile, user, false),
      updatedAt: profile.updatedAt,
      addresses: addresses.map(toAdminAddressView),
    };
  }

  /** Changes the verification state (FRD FM-02 "Admin can ... change status"). The change and its audit record commit together. */
  async adminSetVerificationStatus(
    customerId: string,
    status: CustomerVerificationStatus,
    note: string | undefined,
    actor: Actor & { userId: string },
  ): Promise<AdminCustomerSummary> {
    const profile = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lockProfile(customerId, tx))) {
        throw this.customerNotFound();
      }
      const before = (await this.repository.findProfileById(customerId, tx))!;
      if (before.verificationStatus === status) {
        return before;
      }
      const updated = await this.repository.setVerificationStatus(customerId, status, tx);
      await this.audit.record(
        {
          action: 'customer.verification_status_change',
          entityType: 'customer_profile',
          entityId: customerId,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: { from: before.verificationStatus, to: status, note: note ?? null },
        },
        tx,
      );
      return updated;
    });
    return this.toSummary(profile, await this.users.findById(profile.userId), false);
  }

  async adminAddNote(
    customerId: string,
    note: string,
    actor: Actor & { userId: string },
  ): Promise<CustomerNoteResponse> {
    return this.repository.transaction(async (tx) => {
      if (!(await this.repository.lockProfile(customerId, tx))) {
        throw this.customerNotFound();
      }
      const created = await this.repository.createNote(
        { customerId, authorId: actor.userId, note },
        tx,
      );
      // The note text is operational/personal content: audit its id only.
      await this.audit.record(
        {
          action: 'customer.note_add',
          entityType: 'customer_profile',
          entityId: customerId,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: { noteId: created.id },
        },
        tx,
      );
      return toNoteView(created);
    });
  }

  async adminListNotes(
    customerId: string,
    query: PageQueryDto,
  ): Promise<Page<CustomerNoteResponse>> {
    await this.requireCustomer(customerId);
    const { items, total } = await this.repository.listNotes(
      customerId,
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map(toNoteView),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  // --- helpers ----------------------------------------------------------------------------------------------

  private async requireCustomer(customerId: string): Promise<ProfileRecord> {
    const profile = await this.repository.findProfileById(customerId);
    if (!profile) {
      throw this.customerNotFound();
    }
    return profile;
  }

  private toSummary(
    profile: ProfileRecord,
    user: UserRecord | null,
    maskedMobile: boolean,
  ): AdminCustomerSummary {
    return {
      id: profile.id,
      userId: profile.userId,
      name: profile.name,
      email: profile.email,
      mobile: maskedMobile ? maskMobile(user?.mobile) : (user?.mobile ?? null),
      preferredLanguage: profile.preferredLanguage,
      verificationStatus: profile.verificationStatus,
      accountStatus: user?.status ?? 'ACTIVE',
      createdAt: profile.createdAt,
    };
  }

  private profileNotFound(): DomainException {
    return new DomainException(
      CustomersErrorCode.CUSTOMER_PROFILE_NOT_FOUND,
      'Customer profile not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private customerNotFound(): DomainException {
    return new DomainException(
      CustomersErrorCode.CUSTOMER_NOT_FOUND,
      'Customer not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

function toNoteView(note: NoteRecord): CustomerNoteResponse {
  return { id: note.id, authorId: note.authorId, note: note.note, createdAt: note.createdAt };
}
