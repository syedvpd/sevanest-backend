import { Injectable } from '@nestjs/common';
import type { CustomerVerificationStatus, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export interface ProfileRecord {
  id: string;
  userId: string;
  name: string;
  email: string;
  preferredLanguage: string;
  verificationStatus: CustomerVerificationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AddressRecord {
  id: string;
  customerId: string;
  line: string;
  area: string;
  city: string;
  pincode: string;
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteRecord {
  id: string;
  customerId: string;
  authorId: string;
  note: string;
  createdAt: Date;
}

const PROFILE_SELECT = {
  id: true,
  userId: true,
  name: true,
  email: true,
  preferredLanguage: true,
  verificationStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerProfileSelect;

const ADDRESS_SELECT = {
  id: true,
  customerId: true,
  line: true,
  area: true,
  city: true,
  pincode: true,
  latitude: true,
  longitude: true,
  isDefault: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerAddressSelect;

type AddressRow = Prisma.CustomerAddressGetPayload<{ select: typeof ADDRESS_SELECT }>;

function toAddress(row: AddressRow): AddressRecord {
  return {
    ...row,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
  };
}

export interface ProfileListFilter {
  verificationStatus?: CustomerVerificationStatus;
  userId?: string;
}

/** The only place that reads or writes `customer_profiles`, `customer_addresses` and `customer_notes`. */
@Injectable()
export class CustomersRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // --- profiles -----------------------------------------------------------------------------------------------

  findProfileByUserId(userId: string, db: Db = this.prisma): Promise<ProfileRecord | null> {
    return db.customerProfile.findUnique({ where: { userId }, select: PROFILE_SELECT });
  }

  findProfileById(id: string, db: Db = this.prisma): Promise<ProfileRecord | null> {
    return db.customerProfile.findUnique({ where: { id }, select: PROFILE_SELECT });
  }

  createProfile(
    data: { userId: string; name: string; email: string; preferredLanguage: string },
    tx: Prisma.TransactionClient,
  ): Promise<ProfileRecord> {
    return tx.customerProfile.create({ data, select: PROFILE_SELECT });
  }

  updateProfile(
    id: string,
    data: { name?: string; email?: string; preferredLanguage?: string },
    tx: Prisma.TransactionClient,
  ): Promise<ProfileRecord> {
    return tx.customerProfile.update({ where: { id }, data, select: PROFILE_SELECT });
  }

  setVerificationStatus(
    id: string,
    verificationStatus: CustomerVerificationStatus,
    tx: Prisma.TransactionClient,
  ): Promise<ProfileRecord> {
    return tx.customerProfile.update({
      where: { id },
      data: { verificationStatus },
      select: PROFILE_SELECT,
    });
  }

  /**
   * Serialises every mutation of one customer's addresses/status by locking the parent profile row for the rest of
   * the transaction. Returns false when the profile does not exist.
   */
  async lockProfile(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM customer_profiles WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1;
  }

  async listProfiles(
    filter: ProfileListFilter,
    skip: number,
    take: number,
  ): Promise<{ items: ProfileRecord[]; total: number }> {
    const where: Prisma.CustomerProfileWhereInput = {
      ...(filter.verificationStatus ? { verificationStatus: filter.verificationStatus } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.customerProfile.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        select: PROFILE_SELECT,
      }),
      this.prisma.customerProfile.count({ where }),
    ]);
    return { items, total };
  }

  // --- addresses ----------------------------------------------------------------------------------------------

  async createAddress(
    data: {
      customerId: string;
      line: string;
      area: string;
      city: string;
      pincode: string;
      latitude: number | null;
      longitude: number | null;
      isDefault: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<AddressRecord> {
    return toAddress(await tx.customerAddress.create({ data, select: ADDRESS_SELECT }));
  }

  /** Ownership is part of the query: an address id from another customer simply is not found. */
  async findActiveAddress(
    customerId: string,
    addressId: string,
    db: Db = this.prisma,
  ): Promise<AddressRecord | null> {
    const row = await db.customerAddress.findFirst({
      where: { id: addressId, customerId, isActive: true },
      select: ADDRESS_SELECT,
    });
    return row ? toAddress(row) : null;
  }

  async listActiveAddresses(customerId: string): Promise<AddressRecord[]> {
    const rows = await this.prisma.customerAddress.findMany({
      where: { customerId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: ADDRESS_SELECT,
    });
    return rows.map(toAddress);
  }

  async listAllAddresses(customerId: string): Promise<AddressRecord[]> {
    const rows = await this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: ADDRESS_SELECT,
    });
    return rows.map(toAddress);
  }

  async updateAddress(
    id: string,
    data: Partial<
      Pick<AddressRecord, 'line' | 'area' | 'city' | 'pincode' | 'latitude' | 'longitude'>
    >,
    tx: Prisma.TransactionClient,
  ): Promise<AddressRecord> {
    return toAddress(
      await tx.customerAddress.update({ where: { id }, data, select: ADDRESS_SELECT }),
    );
  }

  async clearDefault(customerId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.customerAddress.updateMany({
      where: { customerId, isDefault: true },
      data: { isDefault: false },
    });
  }

  async markDefault(id: string, tx: Prisma.TransactionClient): Promise<AddressRecord> {
    return toAddress(
      await tx.customerAddress.update({
        where: { id },
        data: { isDefault: true },
        select: ADDRESS_SELECT,
      }),
    );
  }

  async deactivateAddress(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.customerAddress.update({
      where: { id },
      data: { isActive: false, isDefault: false },
      select: { id: true },
    });
  }

  // --- notes --------------------------------------------------------------------------------------------------

  createNote(
    data: { customerId: string; authorId: string; note: string },
    tx: Prisma.TransactionClient,
  ): Promise<NoteRecord> {
    return tx.customerNote.create({
      data,
      select: { id: true, customerId: true, authorId: true, note: true, createdAt: true },
    });
  }

  async listNotes(
    customerId: string,
    skip: number,
    take: number,
  ): Promise<{ items: NoteRecord[]; total: number }> {
    const [items, total] = await Promise.all([
      this.prisma.customerNote.findMany({
        where: { customerId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        select: { id: true, customerId: true, authorId: true, note: true, createdAt: true },
      }),
      this.prisma.customerNote.count({ where: { customerId } }),
    ]);
    return { items, total };
  }
}
