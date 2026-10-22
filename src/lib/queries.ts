import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type ProofMode = 'photo' | 'tap';
export type PactStatus = 'pending' | 'active' | 'archived';

export type InvitePreview =
  | { status: 'invalid'; code: string }
  | {
      status: 'valid' | 'expired' | 'full';
      code: string;
      title: string;
      proof_mode: ProofMode;
      inviter_name: string | null;
      member_count: number;
      max_members: number;
      expires_at: string;
    };

export type PactSummary = {
  id: string;
  title: string;
  status: PactStatus;
  proof_mode: ProofMode;
  current_streak: number;
  pact_members: { user_id: string; left_at: string | null; profiles: { display_name: string } | null }[];
};

export type WaitingRoom = {
  pact: { id: string; title: string; status: PactStatus };
  invite: { code: string; expires_at: string } | null;
};

export const keys = {
  pacts: ['pacts'] as const,
  invitePreview: (code: string) => ['invite-preview', code] as const,
  waitingRoom: (pactId: string) => ['waiting-room', pactId] as const,
  isPro: ['is-pro'] as const,
};

export function useInvitePreview(code: string) {
  return useQuery({
    queryKey: keys.invitePreview(code),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('invite_preview', { code });
      if (error) throw error;
      return data as InvitePreview;
    },
  });
}

export function useMyPacts(enabled: boolean) {
  return useQuery({
    queryKey: keys.pacts,
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pacts')
        .select('id, title, status, proof_mode, current_streak, pact_members(user_id, left_at, profiles(display_name))')
        .neq('status', 'archived')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PactSummary[];
    },
  });
}

export function useWaitingRoom(pactId: string) {
  return useQuery({
    queryKey: keys.waitingRoom(pactId),
    queryFn: async (): Promise<WaitingRoom> => {
      const [pact, invite] = await Promise.all([
        supabase.from('pacts').select('id, title, status').eq('id', pactId).single(),
        supabase
          .from('pact_invites')
          .select('code, expires_at')
          .eq('pact_id', pactId)
          .is('revoked_at', null)
          .order('expires_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (pact.error) throw pact.error;
      if (invite.error) throw invite.error;
      return { pact: pact.data as WaitingRoom['pact'], invite: invite.data };
    },
  });
}

/** Server-side truth for Pro (RevenueCat writes it in Phase 7). */
export function useIsPro(enabled: boolean) {
  return useQuery({
    queryKey: keys.isPro,
    enabled,
    queryFn: async () => {
      const { data } = await supabase.from('entitlements').select('is_pro, expires_at').maybeSingle();
      return !!data?.is_pro && (!data.expires_at || new Date(data.expires_at) > new Date());
    },
  });
}
