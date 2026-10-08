// iOS 27 SDK (Xcode 27) refuses to launch apps that don't adopt the UIScene life cycle.
// expo ships `ExpoAppSceneDelegate`, but the SDK 57 prebuild template doesn't wire it up yet:
// - Info.plist: declare a scene manifest pointing at `EXExpoAppSceneDelegate`.
// - AppDelegate: conform to `ExpoReactNativeFactoryProvider` and stop creating the window /
//   starting React Native itself — the scene delegate does both once the scene connects.
// Remove this plugin once the expo template adopts scenes natively.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE_CLASS = 'EXExpoAppSceneDelegate';
const PROVIDER = 'ExpoReactNativeFactoryProvider';

const START_RN_BLOCK =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;

function withSceneInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: SCENE_DELEGATE_CLASS,
          },
        ],
      },
    };
    return cfg;
  });
}

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('with-scene-lifecycle: expected a Swift AppDelegate');
    }
    let src = cfg.modResults.contents;

    if (!src.includes(PROVIDER)) {
      const declaration = 'class AppDelegate: ExpoAppDelegate {';
      if (!src.includes(declaration)) {
        throw new Error('with-scene-lifecycle: AppDelegate declaration not found');
      }
      src = src.replace(declaration, `class AppDelegate: ExpoAppDelegate, ${PROVIDER} {`);
    }

    if (START_RN_BLOCK.test(src)) {
      src = src.replace(START_RN_BLOCK, '');
    } else if (src.includes('factory.startReactNative(')) {
      throw new Error('with-scene-lifecycle: could not remove startReactNative from AppDelegate');
    }

    cfg.modResults.contents = src;
    return cfg;
  });
}

module.exports = function withSceneLifecycle(config) {
  return withSceneAppDelegate(withSceneInfoPlist(config));
};
