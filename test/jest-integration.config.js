/** Integration tests: need the local PostgreSQL/Redis from docker-compose and an applied migration. */
module.exports = {
  rootDir: '.',
  testRegex: 'integration/.*\\.int-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  testTimeout: 30000,
  // Many suites start whole Nest apps with Redis, queue and database clients; the run must end when the tests do (CI had hung after the summary).
  forceExit: true,
};
