import { getCalendars } from 'expo-localization';

import { supabase } from '@/lib/supabase';

export function deviceTimezone(): string | null {
  return getCalendars()[0]?.timeZone ?? null;
}

/**
 * Called on every launch: tells the server when the device zone differs from
 * the profile. The server decides when (or whether) it applies.
 */
export async function syncTimezone(userId: string): Promise<void> {
  const tz = deviceTimezone();
  if (!tz) return;
  const { data } = await supabase
    .from('profiles')
    .select('timezone, pending_timezone')
    .eq('id', userId)
    .single();
  if (!data || data.timezone === tz || data.pending_timezone === tz) return;
  // rate_limited / invalid_timezone are expected sometimes; nothing to show.
  await supabase.rpc('set_timezone', { tz });
}
