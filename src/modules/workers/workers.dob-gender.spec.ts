import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { WorkersService } from './workers.service';
import type { WorkersRepository, WorkerRecord } from './workers.repository';
import type { ServiceCategoriesService } from '../service-categories/service-categories.service';
import type { UsersService } from '../users/users.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { AppConfigService } from '../../config/app-config.service';
import type { WorkerSubmissionRegistry } from './worker-submission.registry';
import type { WorkerBlacklistHooks } from './worker-blacklist.hooks';
import type { MapsProvider } from '../../integrations/maps/maps-provider.interface';
import type { Prisma } from '../../generated/prisma/client';
import type { Actor, UserRecord } from '../users/users.types';

describe('Worker DOB and Gender Registration & Profile Fields', () => {
  let service: WorkersService;
  let mockRepo: jest.Mocked<Partial<WorkersRepository>>;
  let mockUsers: jest.Mocked<Partial<UsersService>>;
  let mockAudit: jest.Mocked<Partial<AuditService>>;
  let mockCategories: jest.Mocked<Partial<ServiceCategoriesService>>;
  let mockConfig: jest.Mocked<Partial<AppConfigService>>;
  let mockRegistry: jest.Mocked<Partial<WorkerSubmissionRegistry>>;
  let mockBlacklistHooks: jest.Mocked<Partial<WorkerBlacklistHooks>>;
  let mockMaps: jest.Mocked<Partial<MapsProvider>>;

  const mockWorkerRecord: WorkerRecord = {
    id: 'worker-1',
    userId: 'user-1',
    name: 'Ramesh Kumar',
    dateOfBirth: '1995-08-15',
    gender: 'MALE',
    onboardingStatus: 'DRAFT',
    submittedAt: null,
    applicationReference: null,
    signedOffAt: null,
    activatedAt: null,
    experienceMonths: 24,
    expectedSalary: 25000,
    preferredLanguage: 'hi',
    address: null,
    emergencyContact: null,
    previousEmployer: null,
    hasProfilePhoto: false,
    criminalDeclaration: null,
    blacklist: null,
    languages: ['hi'],
    categoryIds: ['cat-1'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const mockUserRecord: UserRecord = {
    id: 'user-1',
    mobile: '9876543210',
    status: 'ACTIVE',
    type: 'WORKER',
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    suspendedReason: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAdminActor: Actor & { userId: string } = {
    userId: 'admin-1',
    roles: ['admin'],
    permissions: [],
  };

  beforeEach(() => {
    mockRepo = {
      transaction: jest
        .fn()
        .mockImplementation(<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
          return fn({} as Prisma.TransactionClient);
        }),
      create: jest.fn().mockResolvedValue(mockWorkerRecord),
      findByUserId: jest.fn().mockResolvedValue(mockWorkerRecord),
      findById: jest.fn().mockResolvedValue(mockWorkerRecord),
      lock: jest.fn().mockResolvedValue(true),
      updateScalars: jest.fn().mockResolvedValue(undefined),
    };

    mockUsers = {
      findById: jest.fn().mockResolvedValue(mockUserRecord),
      findOrCreateByMobile: jest.fn().mockResolvedValue({
        user: { ...mockUserRecord, id: 'user-2', mobile: '9876543211' },
        created: true,
      }),
    };

    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    mockCategories = {
      findByIds: jest
        .fn()
        .mockResolvedValue([
          { id: 'cat-1', code: 'HOUSE_MAID', name: 'House Maid', isEnabled: true },
        ]),
    };

    mockConfig = {
      profilePhotoRequired: false,
      supportedLanguages: ['en', 'hi', 'te'],
    };

    mockRegistry = {
      missingFor: jest.fn().mockResolvedValue([]),
    };

    mockBlacklistHooks = {
      blacklisted: jest.fn().mockResolvedValue(undefined),
    };

    mockMaps = {
      geocode: jest.fn().mockResolvedValue(null),
    };

    service = new WorkersService(
      mockRepo as unknown as WorkersRepository,
      mockCategories as unknown as ServiceCategoriesService,
      mockUsers as unknown as UsersService,
      mockAudit as unknown as AuditService,
      mockConfig as unknown as AppConfigService,
      mockRegistry as unknown as WorkerSubmissionRegistry,
      mockBlacklistHooks as unknown as WorkerBlacklistHooks,
      mockMaps as unknown as MapsProvider,
    );
  });

  describe('createMyProfile with DOB and gender', () => {
    it('successfully creates profile with valid dateOfBirth and gender', async () => {
      const result = await service.createMyProfile('user-1', {
        name: 'Ramesh Kumar',
        dateOfBirth: '1995-08-15',
        gender: 'MALE',
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          name: 'Ramesh Kumar',
          dateOfBirth: new Date('1995-08-15T00:00:00.000Z'),
          gender: 'MALE',
        }),
        expect.anything(),
      );
      expect(result.dateOfBirth).toBe('1995-08-15');
      expect(result.gender).toBe('MALE');
    });

    it('rejects invalid calendar date (e.g. 2026-02-30)', async () => {
      await expect(
        service.createMyProfile('user-1', {
          name: 'Ramesh Kumar',
          dateOfBirth: '2026-02-30',
        }),
      ).rejects.toThrow(DomainException);

      try {
        await service.createMyProfile('user-1', {
          name: 'Ramesh Kumar',
          dateOfBirth: '2026-02-30',
        });
      } catch (err: unknown) {
        const error = err as DomainException;
        expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(error.status).toBe(HttpStatus.BAD_REQUEST);
        expect(error.details?.[0].field).toBe('dateOfBirth');
      }
    });

    it('rejects future date of birth', async () => {
      await expect(
        service.createMyProfile('user-1', {
          name: 'Ramesh Kumar',
          dateOfBirth: '2099-01-01',
        }),
      ).rejects.toThrow(DomainException);

      try {
        await service.createMyProfile('user-1', {
          name: 'Ramesh Kumar',
          dateOfBirth: '2099-01-01',
        });
      } catch (err: unknown) {
        const error = err as DomainException;
        expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(error.status).toBe(HttpStatus.BAD_REQUEST);
        expect(error.details?.[0].field).toBe('dateOfBirth');
      }
    });

    it('allows omitting dateOfBirth and gender on initial profile creation', async () => {
      await service.createMyProfile('user-1', {
        name: 'Ramesh Kumar',
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          name: 'Ramesh Kumar',
          dateOfBirth: null,
          gender: null,
        }),
        expect.anything(),
      );
    });
  });

  describe('updateMyProfile (draft saves and resume)', () => {
    it('updates dateOfBirth and gender successfully', async () => {
      const updatedRecord = {
        ...mockWorkerRecord,
        dateOfBirth: '1992-05-20',
        gender: 'FEMALE' as const,
      };
      mockRepo.findById = jest.fn().mockResolvedValue(updatedRecord);

      const result = await service.updateMyProfile('user-1', {
        dateOfBirth: '1992-05-20',
        gender: 'FEMALE',
      });

      expect(mockRepo.updateScalars).toHaveBeenCalledWith(
        'worker-1',
        expect.objectContaining({
          dateOfBirth: new Date('1992-05-20T00:00:00.000Z'),
          gender: 'FEMALE',
        }),
        expect.anything(),
      );
      expect(result.dateOfBirth).toBe('1992-05-20');
      expect(result.gender).toBe('FEMALE');
    });

    it('allows clearing dateOfBirth and gender with null', async () => {
      const clearedRecord = {
        ...mockWorkerRecord,
        dateOfBirth: null,
        gender: null,
      };
      mockRepo.findById = jest.fn().mockResolvedValue(clearedRecord);

      const result = await service.updateMyProfile('user-1', {
        dateOfBirth: null,
        gender: null,
      });

      expect(mockRepo.updateScalars).toHaveBeenCalledWith(
        'worker-1',
        expect.objectContaining({
          dateOfBirth: null,
          gender: null,
        }),
        expect.anything(),
      );
      expect(result.dateOfBirth).toBeNull();
      expect(result.gender).toBeNull();
    });

    it('rejects invalid date of birth format on update', async () => {
      await expect(
        service.updateMyProfile('user-1', {
          dateOfBirth: 'invalid-date',
        }),
      ).rejects.toThrow(DomainException);
    });

    it('rejects future date of birth on update', async () => {
      await expect(
        service.updateMyProfile('user-1', {
          dateOfBirth: '2099-12-31',
        }),
      ).rejects.toThrow(DomainException);
    });
  });

  describe('adminCreate and adminGet', () => {
    it('adminCreate forwards dateOfBirth and gender', async () => {
      await service.adminCreate(
        {
          mobile: '9876543211',
          name: 'Sunita Devi',
          dateOfBirth: '1990-03-12',
          gender: 'FEMALE',
        },
        mockAdminActor,
      );

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Sunita Devi',
          dateOfBirth: new Date('1990-03-12T00:00:00.000Z'),
          gender: 'FEMALE',
        }),
        expect.anything(),
      );
    });

    it('adminGet exposes dateOfBirth and gender', async () => {
      const detail = await service.adminGet('worker-1');
      expect(detail.dateOfBirth).toBe('1995-08-15');
      expect(detail.gender).toBe('MALE');
    });
  });
});
