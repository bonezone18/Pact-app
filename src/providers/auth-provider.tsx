import type { Session } from '@supabase/supabase-js';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { syncTimezone } from '@/lib/timezone';

type AuthState = { session: Session | null; ready: boolean };

const AuthContext = createContext<AuthState>({ session: null, ready: false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, ready: false });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setState({ session: data.session, ready: true }));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, ready: true });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // Once per launch per user: keep the profile's timezone in step with the device.
  const userId = state.session?.user.id;
  useEffect(() => {
    if (userId) syncTimezone(userId).catch(() => undefined);
  }, [userId]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
