/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'share',
  name: 'ShareRecipe',
  displayName: 'The Perfect Bite',
  bundleIdentifier: '.share',
  frameworks: ['SwiftUI', 'UniformTypeIdentifiers'],
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
    // The device credential the app writes and the extension's background upload reads (spec 6.12).
    'keychain-access-groups': config.ios.entitlements['keychain-access-groups'],
  },
});
