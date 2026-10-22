import { Directory, File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

import { createCheckInQueue, UploadRejected } from '@/lib/check-in-queue';
import { queryClient } from '@/lib/query-client';
import { supabase } from '@/lib/supabase';

const mmkv = createMMKV({ id: 'pact-check-in-queue' });

export const checkInQueue = createCheckInQueue(
  {
    getItem: (key) => mmkv.getString(key) ?? null,
    setItem: (key, value) => mmkv.set(key, value),
    removeItem: (key) => {
      mmkv.remove(key);
    },
  },
  {
    async upload(path, fileUri) {
      const bytes = await new File(fileUri).bytes();
      const { error } = await supabase.storage
        .from('proofs')
        .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
      if (!error) return;
      // 4xx means the server refused this object (not a member, too big...).
      // 401/408/429 and network failures are worth retrying.
      const status = 'status' in error ? Number(error.status) : NaN;
      if (status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
        throw new UploadRejected(error.message);
      }
      throw error;
    },
    async checkIn(args) {
      const { error } = await supabase.rpc('check_in', args);
      return { error };
    },
    async removeObject(path) {
      await supabase.storage.from('proofs').remove([path]);
    },
    deleteLocalFile(uri) {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
    now: () => Date.now(),
    onSynced: (item) => {
      queryClient.invalidateQueries({ queryKey: ['pact-today', item.pactId] });
    },
  },
);

/** Moves a captured photo out of the cache, where the OS may purge it before it syncs. */
export function persistProof(uri: string, id: string): string {
  const dir = new Directory(Paths.document, 'proof-queue');
  if (!dir.exists) dir.create();
  const dest = new File(dir, `${id}.jpg`);
  if (dest.exists) dest.delete();
  new File(uri).moveSync(dest);
  return dest.uri;
}

/**
 * Drives the queue while signed in: on launch, on new items, on app
 * foreground, on reconnect, and when the next backed-off item is due.
 */
export function useCheckInSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      const due = checkInQueue.nextDueIn();
      if (due !== null) timer = setTimeout(() => checkInQueue.process().then(schedule), due + 50);
    };
    const retry = () => checkInQueue.retryNow().then(schedule);

    retry();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') retry();
    });
    const network = Network.addNetworkStateListener(({ isConnected, isInternetReachable }) => {
      if (isConnected && isInternetReachable !== false) retry();
    });
    const unsubscribe = checkInQueue.store.subscribe((state, prev) => {
      if (state.items.some((i) => i.attempts === 0 && !prev.items.some((p) => p.id === i.id))) {
        checkInQueue.process().then(schedule);
      }
    });

    return () => {
      clearTimeout(timer);
      appState.remove();
      network.remove();
      unsubscribe();
    };
  }, [enabled]);
}
