import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { supabase } from '@/lib/supabase';
import type { Today } from '@/lib/today';

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
  today: (pactId: string) => ['pact-today', pactId] as const,
  history: (pactId: string) => ['pact-history', pactId] as const,
  signedUrls: (paths: string[]) => ['signed-urls', ...paths] as const,
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

export function usePactToday(pactId: string) {
  return useQuery({
    queryKey: keys.today(pactId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('pact_today', { pact_id: pactId });
      if (error) throw error;
      return data as Today;
    },
  });
}

/**
 * Live updates for one pact: partner check-ins, reactions, and the engine's
 * streak changes. Sockets drop in the background, so the query also refetches
 * on foreground (see query-client).
 */
export function usePactRealtime(pactId: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.today(pactId) });
    const channel = supabase
      .channel(`pact:${pactId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'check_ins', filter: `pact_id=eq.${pactId}` }, refresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pacts', filter: `id=eq.${pactId}` }, refresh)
      // reactions carry no pact_id; RLS limits the feed to pacts we're in.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, refresh)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [pactId, queryClient]);
}

/** Signed URLs (1 hour) for private proof photos. */
export function useSignedUrls(paths: string[]) {
  const sorted = [...new Set(paths)].sort();
  return useQuery({
    queryKey: keys.signedUrls(sorted),
    enabled: sorted.length > 0,
    staleTime: 50 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('proofs').createSignedUrls(sorted, 3600);
      if (error) throw error;
      const urls: Record<string, string> = {};
      for (const row of data ?? []) if (row.path && row.signedUrl) urls[row.path] = row.signedUrl;
      return urls;
    },
  });
}

export type HistoryCheckIn = {
  id: string;
  user_id: string;
  local_date: string;
  image_path: string | null;
  note: string | null;
  profiles: { display_name: string } | null;
};
export type StreakEvent = { local_date: string; outcome: 'extended' | 'broken' | 'silent_miss' };
export type PactHistory = {
  pact: { title: string; current_streak: number; longest_streak: number; start_date: string | null };
  events: StreakEvent[];
  checkIns: HistoryCheckIn[];
};

export function usePactHistory(pactId: string) {
  return useQuery({
    queryKey: keys.history(pactId),
    queryFn: async (): Promise<PactHistory> => {
      const [pact, events, checkIns] = await Promise.all([
        supabase.from('pacts').select('title, current_streak, longest_streak, start_date').eq('id', pactId).single(),
        supabase.from('streak_events').select('local_date, outcome').eq('pact_id', pactId).order('local_date'),
        supabase
          .from('check_ins')
          .select('id, user_id, local_date, image_path, note, profiles(display_name)')
          .eq('pact_id', pactId)
          .order('local_date', { ascending: false })
          .limit(90),
      ]);
      for (const r of [pact, events, checkIns]) if (r.error) throw r.error;
      return {
        pact: pact.data as PactHistory['pact'],
        events: (events.data ?? []) as StreakEvent[],
        checkIns: (checkIns.data ?? []) as unknown as HistoryCheckIn[],
      };
    },
  });
}
