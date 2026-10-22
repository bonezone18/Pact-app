// Runs every minute (pg_cron + pg_net, see the push_sender migration) and
// delivers due notification_outbox rows through Expo Push.
//
// Secrets (supabase secrets set ...): CRON_SECRET, optionally EXPO_ACCESS_TOKEN.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.

import { createClient } from '@supabase/supabase-js';

import { postToExpo, sendDue } from '../_shared/push-sender.ts';

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || !sameSecret(req.headers.get('x-cron-secret') ?? '', secret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };

  try {
    const summary = await sendDue({
      claim: (maxRows) => rpc('claim_notifications', { max_rows: maxRows }),
      markSent: (ids) => rpc('mark_notifications_sent', { ids }),
      release: (ids, error) => rpc('release_notifications', { ids, error }),
      dropTokens: (tokens) => rpc('drop_push_tokens', { tokens }),
      postToExpo: (messages) => postToExpo(messages, { accessToken: Deno.env.get('EXPO_ACCESS_TOKEN') }),
    });
    return Response.json(summary);
  } catch (e) {
    // Claimed rows stay leased for 2 minutes, then the next run retries them.
    console.error('send-notifications failed', e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
