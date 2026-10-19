// Learn more: https://docs.expo.dev/guides/customizing-metro/
// Sentry's wrapper around Expo's default config adds debug IDs, so release stack traces map to source.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// Drizzle migrations (src/db/migrations/*.sql) are bundled as strings.
config.resolver.sourceExts.push('sql');

module.exports = config;
