import { createMMKV } from 'react-native-mmkv';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const mmkv = createMMKV({ id: 'pact-onboarding' });

/** What the user set out to do before signing in, so we can resume it after. */
export type Intent = { kind: 'join'; code: string } | { kind: 'create' } | null;

type OnboardingState = {
  intent: Intent;
  setIntent: (intent: Intent) => void;
};

export const useOnboarding = create<OnboardingState>()(
  persist(
    (set) => ({
      intent: null,
      setIntent: (intent) => set({ intent }),
    }),
    {
      name: 'onboarding',
      storage: createJSONStorage(() => ({
        getItem: (key) => mmkv.getString(key) ?? null,
        setItem: (key, value) => mmkv.set(key, value),
        removeItem: (key) => {
          mmkv.remove(key);
        },
      })),
    },
  ),
);

/** Where to go once signed in, given the pending intent. */
export function routeForIntent(intent: Intent): '/' | '/create' | `/join/${string}` {
  if (intent?.kind === 'join') return `/join/${intent.code}`;
  if (intent?.kind === 'create') return '/create';
  return '/';
}
