import { deviceTimezone } from '@/lib/timezone';
import { supabase } from '@/lib/supabase';

/**
 * Email + password sign-in for local testing only: shown in development
 * builds when EXPO_PUBLIC_DEV_SIGN_IN=true. Store builds (__DEV__ false)
 * never show it. Apple and Google stay the only real sign-in methods.
 */
export function devSignInEnabled(): boolean {
  return __DEV__ && process.env.EXPO_PUBLIC_DEV_SIGN_IN === 'true';
}

/** Signs in, creating the account on first use (local Supabase skips email confirmation). */
export async function devSignIn(email: string, password: string): Promise<void> {
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (!signIn.error) return;
  if (signIn.error.message !== 'Invalid login credentials') throw signIn.error;

  const name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const signUp = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: name, timezone: deviceTimezone() ?? undefined } },
  });
  if (signUp.error) throw signUp.error;
  // With "Confirm email" turned on (hosted projects) there is no session yet.
  if (!signUp.data.session) {
    throw new Error('Account created, but the project requires email confirmation. Turn it off for testing.');
  }
}
