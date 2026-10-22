import * as SecureStore from 'expo-secure-store';

// Supabase sessions can outgrow what the keychain/keystore handles reliably in
// one entry (~2 KB), so values are split across numbered keys plus a count.
export const CHUNK_SIZE = 1800;

const countKey = (key: string) => `${key}.chunks`;
const chunkKey = (key: string, i: number) => `${key}.${i}`;

async function chunkCount(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(countKey(key));
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

export const chunkedSecureStorage = {
  async getItem(key: string): Promise<string | null> {
    const raw = await SecureStore.getItemAsync(countKey(key));
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    const parts = await Promise.all(
      Array.from({ length: n }, (_, i) => SecureStore.getItemAsync(chunkKey(key, i))),
    );
    // A missing chunk means a torn write; treat the whole value as absent.
    return parts.some((p) => p === null) ? null : parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    const previous = await chunkCount(key);
    const n = Math.ceil(value.length / CHUNK_SIZE);
    for (let i = 0; i < n; i++) {
      await SecureStore.setItemAsync(chunkKey(key, i), value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
    await SecureStore.setItemAsync(countKey(key), String(n));
    for (let i = n; i < previous; i++) {
      await SecureStore.deleteItemAsync(chunkKey(key, i));
    }
  },

  async removeItem(key: string): Promise<void> {
    const n = await chunkCount(key);
    await SecureStore.deleteItemAsync(countKey(key));
    for (let i = 0; i < n; i++) {
      await SecureStore.deleteItemAsync(chunkKey(key, i));
    }
  },
};
