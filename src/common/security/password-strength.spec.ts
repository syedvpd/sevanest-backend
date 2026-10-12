import { weakPasswordProblems } from './password-strength';

describe('weakPasswordProblems (first Super Admin password)', () => {
  const email = 'owner@sevanest.example';

  it('accepts a long, mixed password', () => {
    expect(weakPasswordProblems('tRavel-Lamp-7-orbit-Quartz', email, 12)).toEqual([]);
  });

  it.each([
    ['short', 'Ab1!', 'shorter than 12'],
    ['one class', 'abcdefghijklmnop', 'three of'],
    ['two classes', 'abcdefgh12345678', 'three of'],
    ['repeated run', 'Aaaaaaa-bcd-1234', 'repeated'],
    ['email name', 'Owner-2026-Zebra!x', 'email name'],
    ['common word', 'My-Password-9876!', 'common'],
    ['project name', 'SevaNest#2026-Xyz', 'common'],
  ])('rejects a weak password (%s)', (_name, password, fragment) => {
    expect(weakPasswordProblems(password, email, 12).join('; ')).toContain(fragment);
  });

  it('honours a longer configured minimum', () => {
    expect(weakPasswordProblems('tRavel-Lamp-7', email, 20)).toEqual([
      expect.stringContaining('20'),
    ]);
  });
});
