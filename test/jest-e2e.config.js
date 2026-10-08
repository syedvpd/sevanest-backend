/** E2E tests: boot the real Nest app with PostgreSQL/Redis stubbed. No external services required. */
module.exports = {
  rootDir: '.',
  testRegex: 'e2e/.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
};
