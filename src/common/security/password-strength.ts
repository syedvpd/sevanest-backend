/**
 * Strength rules for the FIRST Super Admin password, which guards everything. Deliberately stricter than the ordinary
 * ADMIN_PASSWORD_MIN_LENGTH check (the general password policy is still open, FR-AUTH-006): at least `minLength` characters, at
 * least three of four character classes, no run of one repeated character, not built from the account's own email name, and not
 * one of the passwords every attacker tries first. Returns the problems found (empty = acceptable).
 */
const COMMON = [
  'password',
  'passw0rd',
  'admin',
  'administrator',
  'welcome',
  'letmein',
  'qwerty',
  'sevanest',
  'changeme',
  'iloveyou',
  '123456',
  '12345678',
  'abc123',
];

export function weakPasswordProblems(password: string, email: string, minLength: number): string[] {
  const problems: string[] = [];
  if (password.length < minLength) problems.push(`shorter than ${minLength} characters`);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    problems.push('needs at least three of: lower case, upper case, digits, symbols');
  }
  if (/(.)\1{3,}/.test(password)) problems.push('contains a long run of one repeated character');
  const lower = password.toLowerCase();
  const name = email.split('@')[0]?.toLowerCase() ?? '';
  if (name.length >= 3 && lower.includes(name)) problems.push('contains the email name');
  if (COMMON.some((word) => lower.includes(word))) problems.push('contains a very common password');
  return problems;
}
