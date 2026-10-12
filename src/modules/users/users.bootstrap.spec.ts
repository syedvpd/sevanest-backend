import { UsersService } from './users.service';

/** First-Super-Admin bootstrap rules with the persistence layer faked (the atomic path is covered by the integration suite). */
describe('UsersService.bootstrapFirstSuperAdmin', () => {
  function build(existingSuperAdmins: number) {
    const tx = {};
    const repository = {
      findRoleIdByCode: jest.fn().mockResolvedValue({ id: 'role-1' }),
      transaction: jest.fn((work: (t: object) => Promise<unknown>) => work(tx)),
      lockSuperAdminAssignments: jest.fn().mockResolvedValue(undefined),
      superAdminAssignmentCount: jest.fn().mockResolvedValue(existingSuperAdmins),
      create: jest.fn().mockResolvedValue({ id: 'user-1' }),
      assignRole: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const hasher = { hash: jest.fn().mockResolvedValue('HASH') };
    const config = { adminLogin: { passwordMinLength: 12 } };
    const service = new UsersService(
      repository as never,
      audit as never,
      {} as never,
      hasher as never,
      config as never,
    );
    return { service, repository, audit, hasher };
  }

  const PASSWORD = 'a-long-enough-password';

  it('creates the first Super Admin under the lock and audits it without credentials', async () => {
    const { service, repository, audit } = build(0);
    await expect(
      service.bootstrapFirstSuperAdmin({ email: 'root@example.test', password: PASSWORD }),
    ).resolves.toBe('CREATED');
    expect(repository.lockSuperAdminAssignments).toHaveBeenCalledTimes(1);
    expect(repository.create).toHaveBeenCalledWith(
      { type: 'ADMIN', email: 'root@example.test', passwordHash: 'HASH' },
      expect.anything(),
    );
    expect(repository.assignRole).toHaveBeenCalledWith('user-1', 'role-1', expect.anything());
    expect(audit.record).toHaveBeenCalledTimes(1);
    const dump = JSON.stringify(audit.record.mock.calls);
    expect(dump).toContain('admin.bootstrap');
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain('root@example.test');
  });

  it('creates nobody and audits a rejection when a Super Admin already exists', async () => {
    const { service, repository, audit } = build(1);
    await expect(
      service.bootstrapFirstSuperAdmin({ email: 'root@example.test', password: PASSWORD }),
    ).resolves.toBe('ALREADY_BOOTSTRAPPED');
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.assignRole).not.toHaveBeenCalled();
    const calls = audit.record.mock.calls as Array<[{ action: string; actorId?: string }]>;
    expect(calls.map((c) => c[0].action)).toEqual(['admin.bootstrap_rejected']);
    expect(JSON.stringify(calls)).not.toContain(PASSWORD);
  });

  it('refuses a password shorter than the configured minimum before touching the database', async () => {
    const { service, repository, hasher } = build(0);
    await expect(
      service.bootstrapFirstSuperAdmin({ email: 'root@example.test', password: 'short' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(repository.transaction).not.toHaveBeenCalled();
  });
});
