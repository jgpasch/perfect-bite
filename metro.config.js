// Learn more: https://docs.expo.dev/guides/customizing-metro/
// Sentry's wrapper around Expo's default config adds debug IDs, so release stack traces map to source.
const path = require('path');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// Drizzle migrations (src/db/migrations/*.sql) are bundled as strings.
config.resolver.sourceExts.push('sql');

// The admin portal (admin/) is its own Next.js project with its own node_modules; Metro never reads it.
// Expo's default blockList is an array of RegExps, so add to it rather than replace it.
const adminDir = path
  .join(__dirname, 'admin')
  .split(/[/\\]/)
  .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('[/\\\\]');
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  new RegExp(`^${adminDir}([/\\\\].*)?$`),
];

module.exports = config;
