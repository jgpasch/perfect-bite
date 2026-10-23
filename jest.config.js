/* global __dirname */
// ralph-parallel runs several agents at once, each in a ../.perfect-bite-ralph/wt-* worktree and each
// running the full suite; at 50% of the cores apiece they starve the machine, so they get 2 workers each.
const inRalphWorktree = /[/\\]\.[^/\\]+-ralph[/\\]wt-\d+$/.test(__dirname);

module.exports = {
  preset: 'jest-expo',
  maxWorkers: inRalphWorktree ? 2 : '50%',
  workerIdleMemoryLimit: '1GB',
  setupFiles: ['<rootDir>/src/test/i18n-setup.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/supabase/',
    '<rootDir>/scripts/',
    '/ios/',
    '/targets/',
    '<rootDir>/admin/',
  ],
  modulePathIgnorePatterns: ['<rootDir>/admin/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^react-native-keyboard-controller$': '<rootDir>/node_modules/react-native-keyboard-controller/jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|uuid|drizzle-orm))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
};
