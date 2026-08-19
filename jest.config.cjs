module.exports = {
  preset: '@react-native/jest-preset',
  resetMocks: true,
  setupFiles: ['<rootDir>/__mocks__/RNCloudStorage.js'],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/example', '<rootDir>/lib'],
  collectCoverageFrom: ['src/**/*.ts', '!src/specs/**', '!src/**/__tests__/**'],
}
