import type { ConfigContext, ExpoConfig } from 'expo/config';

// app.json holds the static config. Google Sign-In's plugin refuses to run
// without the iOS URL scheme (the reversed iOS client ID), so it is only
// added when GOOGLE_IOS_URL_SCHEME is set for the build.
export default ({ config }: ConfigContext): ExpoConfig => {
  const iosUrlScheme = process.env.GOOGLE_IOS_URL_SCHEME;
  return {
    ...(config as ExpoConfig),
    plugins: [
      ...(config.plugins ?? []),
      ...(iosUrlScheme
        ? [['@react-native-google-signin/google-signin', { iosUrlScheme }] as [string, object]]
        : []),
    ],
  };
};
