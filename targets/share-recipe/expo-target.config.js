/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'share',
  name: 'ShareRecipe',
  displayName: 'The Perfect Bite',
  bundleIdentifier: '.share',
  frameworks: ['SwiftUI', 'UniformTypeIdentifiers'],
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
});
