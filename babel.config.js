// Drizzle's expo-sqlite migrator imports generated .sql files as strings (inline-import).
// https://orm.drizzle.team/docs/connect-expo-sqlite
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['inline-import', { extensions: ['.sql'] }]],
  };
};
