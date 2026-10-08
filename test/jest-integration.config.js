/** Integration tests: need the local PostgreSQL/Redis from docker-compose and an applied migration. */
module.exports = {
  rootDir: '.',
  testRegex: 'integration/.*\\.int-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  testTimeout: 30000,
};
