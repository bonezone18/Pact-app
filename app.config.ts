import type { ConfigContext, ExpoConfig } from 'expo/config';

// app.json holds the static config. Two build-time inputs come from the
// environment so no credentials live in git:
// - GOOGLE_IOS_URL_SCHEME: Google Sign-In's plugin refuses to run without the
//   iOS URL scheme (the reversed iOS client ID), so it's only added when set.
// - GOOGLE_SERVICES_JSON: path to Firebase's google-services.json, needed for
//   Android push (an EAS file environment variable in cloud builds).
export default ({ config }: ConfigContext): ExpoConfig => {
  const iosUrlScheme = process.env.GOOGLE_IOS_URL_SCHEME;
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
  return {
    ...(config as ExpoConfig),
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    plugins: [
      ...(config.plugins ?? []),
      ...(iosUrlScheme
        ? [['@react-native-google-signin/google-signin', { iosUrlScheme }] as [string, object]]
        : []),
    ],
  };
};
