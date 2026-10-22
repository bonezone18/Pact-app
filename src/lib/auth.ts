import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { GoogleSignin, isErrorWithCode, statusCodes } from '@react-native-google-signin/google-signin';

import { supabase } from '@/lib/supabase';

export class SignInCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

let googleConfigured = false;
function configureGoogle() {
  if (googleConfigured) return;
  GoogleSignin.configure({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  });
  googleConfigured = true;
}

export async function signInWithApple(): Promise<void> {
  // Apple gets the SHA-256 of the nonce; Supabase gets the raw value to compare.
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') throw new SignInCancelled();
    throw e;
  }
  if (!credential.identityToken) throw new Error('Apple did not return an identity token');

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce: rawNonce,
  });
  if (error) throw error;

  // Apple shares the name only on the very first sign-in and never puts it in
  // the token, so copy it to the profile while we have it.
  const name = [credential.fullName?.givenName, credential.fullName?.familyName]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (name && data.user) {
    await supabase.from('profiles').update({ display_name: name.slice(0, 40) }).eq('id', data.user.id);
  }
}

export async function signInWithGoogle(): Promise<void> {
  configureGoogle();
  await GoogleSignin.hasPlayServices();
  let idToken: string | null;
  try {
    const response = await GoogleSignin.signIn();
    if (response.type !== 'success') throw new SignInCancelled();
    idToken = response.data.idToken;
  } catch (e) {
    if (isErrorWithCode(e) && e.code === statusCodes.SIGN_IN_CANCELLED) throw new SignInCancelled();
    throw e;
  }
  if (!idToken) throw new Error('Google did not return an ID token');

  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
  if (googleConfigured) await GoogleSignin.signOut().catch(() => undefined);
}
