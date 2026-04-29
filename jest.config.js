/**
 * jest.config.js
 *
 * Three projects = three test layers, each with its own timeout and setup.
 * Run all:         npx jest
 * Run unit only:   npx jest --selectProjects unit
 * Run integration: npx jest --selectProjects integration
 * Run e2e:         npx jest --selectProjects e2e
 * Coverage:        npx jest --coverage
 */

module.exports = {
  projects: [
    {
      displayName:     'unit',
      testMatch:       ['<rootDir>/test/unit/**/*.test.js'],
      testEnvironment: 'node',
      testTimeout:     10000,
    },
    {
      displayName:     'integration',
      testMatch:       ['<rootDir>/test/integration/**/*.test.js'],
      testEnvironment: 'node',
      testTimeout:     15000,
    },
    {
      displayName:     'e2e',
      testMatch:       ['<rootDir>/test/e2e/**/*.test.js'],
      testEnvironment: 'node',
      testTimeout:     20000,
    },
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/main.js',
    '!src/**/*.entity.js',
    '!src/**/*.module.js',
    '!src/common/interceptors/**',
  ],
  coverageThreshold: {
    global: {
      lines:      90,
      functions:  90,
      branches:   80,
      statements: 90,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
};