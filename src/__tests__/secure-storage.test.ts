import * as SecureStore from 'expo-secure-store';

import { CHUNK_SIZE, chunkedSecureStorage } from '@/lib/secure-storage';

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

beforeEach(() => store.clear());

describe('chunked secure storage', () => {
  it('round-trips a small value', async () => {
    await chunkedSecureStorage.setItem('sb-auth', 'hello');
    expect(await chunkedSecureStorage.getItem('sb-auth')).toBe('hello');
  });

  it('splits a large session so no keychain entry exceeds the chunk size', async () => {
    const session = JSON.stringify({ access_token: 'x'.repeat(5000), refresh_token: 'y'.repeat(300) });
    await chunkedSecureStorage.setItem('sb-auth', session);
    expect(await chunkedSecureStorage.getItem('sb-auth')).toBe(session);
    for (const value of store.values()) expect(value.length).toBeLessThanOrEqual(CHUNK_SIZE);
    expect(store.get('sb-auth.chunks')).toBe(String(Math.ceil(session.length / CHUNK_SIZE)));
  });

  it('drops leftover chunks when a value shrinks', async () => {
    await chunkedSecureStorage.setItem('sb-auth', 'a'.repeat(CHUNK_SIZE * 3));
    await chunkedSecureStorage.setItem('sb-auth', 'short');
    expect(await chunkedSecureStorage.getItem('sb-auth')).toBe('short');
    expect([...store.keys()].sort()).toEqual(['sb-auth.0', 'sb-auth.chunks']);
  });

  it('removes every chunk', async () => {
    await chunkedSecureStorage.setItem('sb-auth', 'a'.repeat(CHUNK_SIZE * 2 + 1));
    await chunkedSecureStorage.removeItem('sb-auth');
    expect(store.size).toBe(0);
    expect(await chunkedSecureStorage.getItem('sb-auth')).toBeNull();
  });

  it('treats a torn write as no session rather than a corrupt one', async () => {
    await chunkedSecureStorage.setItem('sb-auth', 'a'.repeat(CHUNK_SIZE * 2));
    store.delete('sb-auth.1');
    expect(await chunkedSecureStorage.getItem('sb-auth')).toBeNull();
  });
});
