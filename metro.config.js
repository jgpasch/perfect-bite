// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Drizzle migrations (src/db/migrations/*.sql) are bundled as strings.
config.resolver.sourceExts.push('sql');

module.exports = config;
