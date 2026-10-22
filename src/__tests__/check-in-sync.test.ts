// The production wiring of the queue: Supabase Storage + RPC, the local file,
// and what triggers a sync (launch, new item, foreground, reconnect).
import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { fake } from '@/test/fake-supabase';

jest.mock('@/lib/supabase', () => ({ supabase: require('@/test/fake-supabase').fake.client }));

const mockNetworkListeners: ((e: { isConnected?: boolean; isInternetReachable?: boolean }) => void)[] = [];
jest.mock('expo-network', () => ({
  addNetworkStateListener: (l: (e: object) => void) => {
    mockNetworkListeners.push(l);
    return { remove: () => mockNetworkListeners.splice(mockNetworkListeners.indexOf(l), 1) };
  },
}));

const mockFiles = new Map<string, Uint8Array>();
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    async bytes() {
      return mockFiles.get(this.uri)!;
    }
    delete() {
      mockFiles.delete(this.uri);
    }
    moveSync(dest: File) {
      mockFiles.set(dest.uri, mockFiles.get(this.uri)!);
      mockFiles.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    exists = true;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    create() {}
  }
  return { File, Directory, Paths: { document: { uri: 'file:///docs' } } };
});

const { client, controls, storageApi } = fake;
// Loaded after the mocks.
const { checkInQueue, persistProof, useCheckInSync } = require('@/lib/check-in-sync') as typeof import('@/lib/check-in-sync');

const item = (id: string, fileUri: string | null) => ({
  id,
  pactId: 'p1',
  userId: 'user-1',
  forDate: '2026-10-22',
  fileUri,
  note: null,
  capturedAt: '2026-10-22T20:00:00.000Z',
});

const flush = () => act(async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
});

beforeEach(() => {
  controls.reset();
  checkInQueue.store.setState({ items: [], notices: [] });
  mockFiles.clear();
});

it('persistProof moves the capture out of the cache into documents', () => {
  mockFiles.set('file:///cache/proof.jpg', new Uint8Array([1, 2, 3]));
  expect(persistProof('file:///cache/proof.jpg', 'abc')).toBe('file:///docs/proof-queue/abc.jpg');
  expect(mockFiles.has('file:///cache/proof.jpg')).toBe(false);
  expect(mockFiles.get('file:///docs/proof-queue/abc.jpg')).toEqual(new Uint8Array([1, 2, 3]));
});

it('uploads the bytes as JPEG with upsert, then calls check_in, then deletes the local file', async () => {
  mockFiles.set('file:///docs/proof-queue/i1.jpg', new Uint8Array([9, 9]));
  checkInQueue.enqueue(item('i1', 'file:///docs/proof-queue/i1.jpg'));
  await checkInQueue.process();

  expect(client.storage.from).toHaveBeenCalledWith('proofs');
  expect(storageApi.upload).toHaveBeenCalledWith('p1/user-1/i1.jpg', new Uint8Array([9, 9]), {
    contentType: 'image/jpeg',
    upsert: true,
  });
  expect(client.rpc).toHaveBeenCalledWith('check_in', {
    pact_id: 'p1',
    image_path: 'p1/user-1/i1.jpg',
    note: null,
    captured_at: '2026-10-22T20:00:00.000Z',
  });
  expect(mockFiles.has('file:///docs/proof-queue/i1.jpg')).toBe(false);
});

it.each([
  [403, 'gives up', 0],
  [413, 'gives up', 0],
  [401, 'retries', 1],
  [429, 'retries', 1],
  [500, 'retries', 1],
])('an upload answered %d %s', async (status, _what, remaining) => {
  mockFiles.set('file:///docs/proof-queue/i2.jpg', new Uint8Array([1]));
  storageApi.upload.mockResolvedValue({ data: null, error: { message: 'nope', status } });
  checkInQueue.enqueue(item('i2', 'file:///docs/proof-queue/i2.jpg'));
  await checkInQueue.process();
  expect(checkInQueue.store.getState().items).toHaveLength(remaining);
  expect(client.rpc).not.toHaveBeenCalled();
});

describe('useCheckInSync', () => {
  beforeEach(() => {
    client.rpc.mockResolvedValue({ data: null, error: { message: 'TypeError: Network request failed' } });
  });

  it('syncs on launch, and again when a new check-in is queued', async () => {
    checkInQueue.enqueue(item('a', null));
    const hook = await renderHook(() => useCheckInSync(true));
    await flush();
    expect(client.rpc).toHaveBeenCalledTimes(1);

    client.rpc.mockResolvedValue({ data: null, error: null });
    checkInQueue.enqueue(item('b', null));
    await flush();
    // b is processed immediately; a is still backing off.
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(checkInQueue.store.getState().items.map((i) => i.id)).toEqual(['a']);
    await hook.unmount();
  });

  it('retries immediately on reconnect and on returning to the foreground', async () => {
    const appStateListeners: ((s: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, l) => {
      appStateListeners.push(l as (s: string) => void);
      return { remove: jest.fn() } as never;
    });

    checkInQueue.enqueue(item('c', null));
    const hook = await renderHook(() => useCheckInSync(true));
    await flush();
    expect(client.rpc).toHaveBeenCalledTimes(1);

    mockNetworkListeners.forEach((l) => l({ isConnected: true, isInternetReachable: true }));
    await flush();
    expect(client.rpc).toHaveBeenCalledTimes(2);

    client.rpc.mockResolvedValue({ data: null, error: null });
    appStateListeners.forEach((l) => l('active'));
    await flush();
    expect(client.rpc).toHaveBeenCalledTimes(3);
    expect(checkInQueue.store.getState().items).toEqual([]);
    await hook.unmount();
  });

  it('does nothing while signed out', async () => {
    checkInQueue.enqueue(item('d', null));
    const hook = await renderHook(() => useCheckInSync(false));
    await flush();
    expect(client.rpc).not.toHaveBeenCalled();
    await hook.unmount();
  });
});
