/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  // 2026-05-08：排除其他 worktree 的 test 干擾本 worktree 跑 npm test
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/worktrees/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs' } }],
  },
  // 2026-05-08：每個 test 跑前 clear all mocks（避免跨 file mock state leak）
  clearMocks: true,
};
module.exports = config;
