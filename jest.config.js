/** Unit tests: colocated *.spec.ts under src/. No database or Redis required. */
module.exports = {
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  collectCoverageFrom: ['**/*.ts', '!generated/**', '!main.ts', '!worker.ts', '!**/*.module.ts'],
  coverageDirectory: '../coverage',
};
