import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { MAPS_PROVIDER, type MapsProvider } from '../../integrations/maps/maps-provider.interface';
import { assertIfMatch } from '../../common/concurrency/if-match';
import { AppConfigService } from '../../config/app-config.service';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import type { Prisma } from '../../generated/prisma/client';
import { AddressRecord, CustomersRepository } from './customers.repository';
import {
  AddressResponse,
  AdminAddressResponse,
  CreateAddressDto,
  UpdateAddressDto,
} from './dto/customers.dto';
import { changedFieldNames } from '../../common/validation/fields';
import { assertCoordinatePair } from './domain/customer.rules';
import {
  ServiceAreasService,
  type ServiceabilityResult,
} from '../availability/service-areas.service';

export const AddressErrorCode = {
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND',
  PROFILE_REQUIRED: 'CUSTOMER_PROFILE_REQUIRED',
  ADDRESS_LIMIT_REACHED: 'ADDRESS_LIMIT_REACHED',
} as const;

/**
 * Most saved (active) addresses one customer may hold. An engineering default that keeps the list and the geocoding cost bounded
 * (audit F-005); the product owner may change the number. Deleted addresses do not count.
 */
export const MAX_ACTIVE_ADDRESSES = 20;

export function toAddressView(
  address: AddressRecord,
  serviceability?: ServiceabilityResult,
): AddressResponse {
  return {
    id: address.id,
    line: address.line,
    area: address.area,
    city: address.city,
    pincode: address.pincode,
    label: address.label,
    line2: address.line2,
    state: address.state,
    latitude: address.latitude,
    longitude: address.longitude,
    isDefault: address.isDefault,
    isServiceable: serviceability?.isServiceable ?? false,
    unserviceableReason: serviceability
      ? serviceability.unserviceableReason
      : 'AREA_NOT_SERVICEABLE',
    createdAt: address.createdAt,
    updatedAt: address.updatedAt,
  };
}

export function toAdminAddressView(
  address: AddressRecord,
  serviceability?: ServiceabilityResult,
): AdminAddressResponse {
  return { ...toAddressView(address, serviceability), isActive: address.isActive };
}

/**
 * A customer's saved addresses (FR-CUS-004/005). Every operation resolves the profile from the AUTHENTICATED user and
 * scopes every lookup by that profile, so another customer's address id is simply "not found" (no IDOR, no existence
 * leak). Mutations lock the profile row first, which serialises concurrent default changes for one customer; the
 * database additionally enforces "at most one default" and "a default is active".
 * Business rules the specs leave open are NOT invented: the first address is not auto-defaulted, and removing the
 * default leaves the customer with no default until they choose one.
 */
@Injectable()
export class CustomerAddressesService {
  constructor(
    private readonly repository: CustomersRepository,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly areas: ServiceAreasService,
    @Inject(MAPS_PROVIDER) private readonly maps: MapsProvider,
  ) {}

  private readonly logger = new Logger(CustomerAddressesService.name);

  private async toAddressViewWithServiceability(address: AddressRecord): Promise<AddressResponse> {
    const serviceability = await this.areas.evaluateServiceability({
      area: address.area,
      city: address.city,
      latitude: address.latitude,
      longitude: address.longitude,
    });
    return toAddressView(address, serviceability);
  }

  async list(userId: string): Promise<AddressResponse[]> {
    const profile = await this.requireProfile(userId);
    const addresses = await this.repository.listActiveAddresses(profile.id);
    return Promise.all(addresses.map((a) => this.toAddressViewWithServiceability(a)));
  }

  async get(userId: string, addressId: string): Promise<AddressResponse> {
    const profile = await this.requireProfile(userId);
    const address = await this.repository.findActiveAddress(profile.id, addressId);
    if (!address) {
      throw this.notFound();
    }
    return this.toAddressViewWithServiceability(address);
  }

  /**
   * DEC-18: when the saved address has no map location (the customer sent none), it is geocoded AFTER the commit. A location that exists
   * (a pin the customer set, or an earlier lookup) is never replaced behind their back; send new coordinates, or null to clear it. A provider that is off, slow,
   * failing or finds nothing never blocks or delays the save beyond its timeout: the address simply stays without coordinates.
   */
  private async withGeocode(userId: string, saved: AddressResponse): Promise<AddressResponse> {
    if (saved.latitude !== null) return saved;
    try {
      const text = [saved.line, saved.line2, saved.area, saved.city, saved.pincode, 'India']
        .filter(Boolean)
        .join(', ');
      const point = await this.maps.geocode(text);
      if (!point) return saved;
      const profile = await this.requireProfile(userId);
      const updated = await this.repository.setAddressCoordinates(profile.id, saved.id, {
        latitude: Math.round(point.latitude * 1e6) / 1e6,
        longitude: Math.round(point.longitude * 1e6) / 1e6,
      });
      return updated ? this.toAddressViewWithServiceability(updated) : saved;
    } catch (error) {
      this.logger.warn(`Address saved without a map location: ${(error as Error).message}`);
      return saved;
    }
  }

  async create(userId: string, dto: CreateAddressDto): Promise<AddressResponse> {
    assertCoordinatePair(dto.latitude, dto.longitude);
    const saved = await this.createSaved(userId, dto);
    return dto.latitude == null ? this.withGeocode(userId, saved) : saved;
  }

  private async createSaved(userId: string, dto: CreateAddressDto): Promise<AddressResponse> {
    return this.mutate(userId, async (tx, customerId) => {
      // The customer row is locked by mutate(), so two parallel creates cannot both pass this check.
      if ((await this.repository.countActiveAddresses(customerId, tx)) >= MAX_ACTIVE_ADDRESSES) {
        throw new DomainException(
          AddressErrorCode.ADDRESS_LIMIT_REACHED,
          `You can save at most ${MAX_ACTIVE_ADDRESSES} addresses; delete one to add another`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const wantsDefault = dto.isDefault === true;
      if (wantsDefault) {
        await this.repository.clearDefault(customerId, tx);
      }
      const created = await this.repository.createAddress(
        {
          customerId,
          line: dto.line,
          area: dto.area,
          city: dto.city,
          pincode: dto.pincode,
          label: dto.label ?? null,
          line2: dto.line2 ?? null,
          state: dto.state ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          isDefault: wantsDefault,
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'customer.address_create',
          entityType: 'customer_address',
          entityId: created.id,
          actorId: userId,
          metadata: { isDefault: created.isDefault },
        },
        tx,
      );
      await this.autoVerify(customerId, userId, tx);
      return this.toAddressViewWithServiceability(created);
    });
  }

  async update(
    userId: string,
    addressId: string,
    dto: UpdateAddressDto,
    ifMatch?: string,
  ): Promise<AddressResponse> {
    const saved = await this.updateSaved(userId, addressId, dto, ifMatch);
    const textChanged = ['line', 'line2', 'area', 'city', 'pincode'].some(
      (key) => (dto as Record<string, unknown>)[key] !== undefined,
    );
    return textChanged && dto.latitude === undefined && dto.longitude === undefined
      ? this.withGeocode(userId, saved)
      : saved;
  }

  private async updateSaved(
    userId: string,
    addressId: string,
    dto: UpdateAddressDto,
    ifMatch?: string,
  ): Promise<AddressResponse> {
    const fields = changedFieldNames(dto);
    if (fields.length === 0) {
      throw new DomainException(
        'VALIDATION_FAILED',
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'body', messages: ['at least one field must be provided'] }],
      );
    }
    return this.mutate(userId, async (tx, customerId) => {
      const existing = await this.repository.findActiveAddress(customerId, addressId, tx);
      if (!existing) {
        throw this.notFound();
      }
      assertIfMatch(ifMatch, existing.updatedAt);
      // `null` explicitly clears a coordinate; the pair must stay consistent after the merge.
      const latitude = dto.latitude === undefined ? existing.latitude : dto.latitude;
      const longitude = dto.longitude === undefined ? existing.longitude : dto.longitude;
      assertCoordinatePair(latitude, longitude);
      const updated = await this.repository.updateAddress(
        addressId,
        {
          line: dto.line,
          area: dto.area,
          city: dto.city,
          pincode: dto.pincode,
          label: dto.label,
          line2: dto.line2,
          state: dto.state,
          ...(dto.latitude !== undefined || dto.longitude !== undefined
            ? { latitude, longitude }
            : {}),
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'customer.address_update',
          entityType: 'customer_address',
          entityId: addressId,
          actorId: userId,
          metadata: { changedFields: fields },
        },
        tx,
      );
      return this.toAddressViewWithServiceability(updated);
    });
  }

  /** Idempotent: making the current default the default again changes nothing and writes no audit record. */
  async setDefault(userId: string, addressId: string): Promise<AddressResponse> {
    return this.mutate(userId, async (tx, customerId) => {
      const existing = await this.repository.findActiveAddress(customerId, addressId, tx);
      if (!existing) {
        throw this.notFound();
      }
      if (existing.isDefault) {
        return this.toAddressViewWithServiceability(existing);
      }
      await this.repository.clearDefault(customerId, tx);
      const updated = await this.repository.markDefault(addressId, tx);
      await this.audit.record(
        {
          action: 'customer.address_set_default',
          entityType: 'customer_address',
          entityId: addressId,
          actorId: userId,
        },
        tx,
      );
      return this.toAddressViewWithServiceability(updated);
    });
  }

  /** Soft removal: addresses are kept (later bookings reference them) but no longer visible or usable by the customer. */
  async deactivate(userId: string, addressId: string): Promise<void> {
    await this.mutate(userId, async (tx, customerId) => {
      const existing = await this.repository.findActiveAddress(customerId, addressId, tx);
      if (!existing) {
        throw this.notFound();
      }
      await this.repository.deactivateAddress(addressId, tx);
      await this.audit.record(
        {
          action: 'customer.address_deactivate',
          entityType: 'customer_address',
          entityId: addressId,
          actorId: userId,
          metadata: { wasDefault: existing.isDefault },
        },
        tx,
      );
      await this.autoVerify(customerId, userId, tx);
    });
  }

  /**
   * Basic customer verification (FR-CUS / FR-VER-007), interim rule: a customer is VERIFIED while their mobile is OTP-verified (always true),
   * the profile is complete (name and email are required to create it) and they hold at least one active saved address; PENDING when the last
   * address is removed. A status an administrator set by hand is never overridden. Switch off with CUSTOMER_AUTO_VERIFY=false.
   */
  private async autoVerify(
    customerId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!this.config.customerAutoVerify) return;
    const state = await this.repository.verificationState(customerId, tx);
    if (!state || state.adminSet) return;
    const target = state.activeAddresses > 0 ? 'VERIFIED' : 'PENDING';
    if (target === state.status) return;
    await this.repository.setVerificationStatus(customerId, target, tx);
    await this.audit.record(
      {
        action: 'customer.auto_verification',
        entityType: 'customer_profile',
        entityId: customerId,
        actorId: userId,
        metadata: { from: state.status, to: target },
      },
      tx,
    );
  }

  private async requireProfile(userId: string): Promise<{ id: string }> {
    const profile = await this.repository.findProfileByUserId(userId);
    if (!profile) {
      throw this.profileRequired();
    }
    return profile;
  }

  /** Runs `work` in one transaction with the customer's profile row locked. */
  private mutate<T>(
    userId: string,
    work: (tx: Prisma.TransactionClient, customerId: string) => Promise<T>,
  ): Promise<T> {
    return this.repository.transaction(async (tx) => {
      const profile = await this.repository.findProfileByUserId(userId, tx);
      if (!profile || !(await this.repository.lockProfile(profile.id, tx))) {
        throw this.profileRequired();
      }
      return work(tx, profile.id);
    });
  }

  private notFound(): DomainException {
    return new DomainException(
      AddressErrorCode.ADDRESS_NOT_FOUND,
      'Address not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private profileRequired(): DomainException {
    return new DomainException(
      AddressErrorCode.PROFILE_REQUIRED,
      'Create your profile before managing addresses',
      HttpStatus.CONFLICT,
    );
  }
}
