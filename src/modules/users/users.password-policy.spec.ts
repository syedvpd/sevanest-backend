import { UsersService } from './users.service';

describe('UsersService.assertPasswordMeetsPolicy', () => {
  const service = new UsersService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { adminLogin: { passwordMinLength: 12 } } as never,
  );

  it('rejects a password made only of whitespace, however long', () => {
    expect(() => service.assertPasswordMeetsPolicy(' '.repeat(16))).toThrow(
      'Request validation failed',
    );
  });

  it('rejects a password shorter than the minimum', () => {
    expect(() => service.assertPasswordMeetsPolicy('short')).toThrow('Request validation failed');
  });

  it('accepts a long enough password', () => {
    expect(() => service.assertPasswordMeetsPolicy('a-long-enough-password')).not.toThrow();
  });
});
