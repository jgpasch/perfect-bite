const { withXcodeProjectBeta } = require('@bacons/apple-targets/build/with-bacons-xcode');

const NAME = 'ShareRecipe';
/** The build setting the extension's Info.plist reads as `ShareIngestURL` (spec 4.10 step 3). */
const URL_SETTING = 'SHARE_INGEST_URL';

/**
 * The `share-ingest` URL the background upload posts to: the Supabase URL the app is built with
 * (`EXPO_PUBLIC_SUPABASE_URL`, loaded from the .env files with the app config), or null without one.
 */
function shareIngestUrl(env) {
  const base = (env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/]/i.test(base) ? `${base}/functions/v1/share-ingest` : null;
}

/** Sets (or, with no URL, removes) `SHARE_INGEST_URL` on the share extension's target. */
function setShareIngestUrl(project, url) {
  for (const target of project.rootObject.props.targets) {
    if (target.props.productName !== NAME) continue;
    if (url) target.setBuildSetting(URL_SETTING, url);
    else target.removeBuildSetting(URL_SETTING);
  }
}

/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => {
  // Registered before apple-targets adds this target, so it runs after the target exists.
  withXcodeProjectBeta(config, (cfg) => {
    setShareIngestUrl(cfg.modResults, shareIngestUrl(process.env));
    return cfg;
  });
  return {
    type: 'share',
    name: NAME,
    displayName: 'The Perfect Bite',
    bundleIdentifier: '.share',
    frameworks: ['SwiftUI', 'UniformTypeIdentifiers'],
    entitlements: {
      'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
      // The device credential the app writes and the extension's background upload reads (spec 6.12).
      'keychain-access-groups': config.ios.entitlements['keychain-access-groups'],
    },
  };
};
module.exports.shareIngestUrl = shareIngestUrl;
module.exports.setShareIngestUrl = setShareIngestUrl;
module.exports.URL_SETTING = URL_SETTING;
