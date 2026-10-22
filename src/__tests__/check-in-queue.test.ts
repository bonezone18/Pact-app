import type { StateStorage } from 'zustand/middleware';

import {
  backoff,
  createCheckInQueue,
  MAX_DELAY_MS,
  pendingCheckIn,
  type QueueDeps,
  UploadRejected,
} from '@/lib/check-in-queue';

// Survives "app restarts": a new queue built on the same storage sees it.
function memoryStorage(): StateStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function fakeDeps(overrides: Partial<QueueDeps> = {}) {
  let clock = 1_000_000;
  const deps = {
    upload: jest.fn(async () => undefined),
    checkIn: jest.fn(async () => ({ error: null as { message: string } | null })),
    removeObject: jest.fn(async () => undefined),
    deleteLocalFile: jest.fn(),
    now: () => clock,
    onSynced: jest.fn(),
    ...overrides,
  } as QueueDeps & Record<keyof QueueDeps, jest.Mock>;
  return { deps, advance: (ms: number) => (clock += ms) };
}

const PHOTO = {
  id: 'item-1',
  pactId: 'pact-1',
  userId: 'user-1',
  forDate: '2026-10-22',
  fileUri: 'file:///docs/proof-queue/item-1.jpg',
  note: 'Done!',
  capturedAt: '2026-10-22T20:00:00.000Z',
};
const TAP = { ...PHOTO, id: 'item-2', fileUri: null, note: null };

const networkDown = () => {
  throw new TypeError('Network request failed');
};

describe('check-in queue', () => {
  it('uploads the photo to {pact}/{user}/{item id}.jpg, then calls check_in, then clears', async () => {
    const { deps } = fakeDeps();
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(PHOTO);
    expect(pendingCheckIn(q.store.getState(), 'pact-1', '2026-10-22')).toBeDefined();

    await q.process();

    expect(deps.upload).toHaveBeenCalledWith('pact-1/user-1/item-1.jpg', PHOTO.fileUri);
    expect(deps.checkIn).toHaveBeenCalledWith({
      pact_id: 'pact-1',
      image_path: 'pact-1/user-1/item-1.jpg',
      note: 'Done!',
      captured_at: PHOTO.capturedAt,
    });
    expect(deps.upload.mock.invocationCallOrder[0]).toBeLessThan(deps.checkIn.mock.invocationCallOrder[0]);
    expect(q.store.getState().items).toEqual([]);
    expect(deps.deleteLocalFile).toHaveBeenCalledWith(PHOTO.fileUri);
    expect(deps.onSynced).toHaveBeenCalledTimes(1);
  });

  it('tap mode skips the upload', async () => {
    const { deps } = fakeDeps();
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(TAP);
    await q.process();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.checkIn).toHaveBeenCalledWith(expect.objectContaining({ image_path: null }));
    expect(q.store.getState().items).toEqual([]);
  });

  it('keeps the item queued with backoff while offline', async () => {
    const { deps, advance } = fakeDeps({ upload: jest.fn(async () => networkDown()) });
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(PHOTO);

    await q.process();
    expect(q.store.getState().items[0]).toMatchObject({ attempts: 1, imagePath: null });
    expect(q.nextDueIn()).toBe(5_000);

    await q.process(); // not due yet: no new attempt
    expect(deps.upload).toHaveBeenCalledTimes(1);

    advance(5_000);
    await q.process();
    expect(q.store.getState().items[0].attempts).toBe(2);
    expect(q.nextDueIn()).toBe(10_000);
  });

  it('caps the backoff at 5 minutes', () => {
    expect([1, 2, 3, 4].map(backoff)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoff(7)).toBe(MAX_DELAY_MS);
    expect(backoff(50)).toBe(MAX_DELAY_MS);
  });

  it('a retry after a failed check_in reuses the uploaded photo', async () => {
    const checkIn = jest
      .fn()
      .mockResolvedValueOnce({ error: { message: 'TypeError: Network request failed' } })
      .mockResolvedValueOnce({ error: null });
    const { deps, advance } = fakeDeps({ checkIn });
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(PHOTO);

    await q.process();
    expect(q.store.getState().items[0].imagePath).toBe('pact-1/user-1/item-1.jpg');
    advance(5_000);
    await q.process();

    expect(deps.upload).toHaveBeenCalledTimes(1);
    expect(checkIn).toHaveBeenCalledTimes(2);
    expect(q.store.getState().items).toEqual([]);
  });

  it('treats already_checked_in as success (an earlier attempt landed)', async () => {
    const { deps } = fakeDeps({ checkIn: jest.fn(async () => ({ error: { message: 'already_checked_in' } })) });
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(TAP);
    await q.process();
    expect(q.store.getState().items).toEqual([]);
    expect(q.store.getState().notices).toEqual([]);
    expect(deps.onSynced).toHaveBeenCalled();
  });

  it('day_closed: clears the item, leaves a notice and deletes the orphan photo', async () => {
    const { deps } = fakeDeps({ checkIn: jest.fn(async () => ({ error: { message: 'day_closed' } })) });
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(PHOTO);
    await q.process();

    expect(q.store.getState().items).toEqual([]);
    expect(q.store.getState().notices).toEqual([
      {
        id: 'item-1',
        pactId: 'pact-1',
        forDate: '2026-10-22',
        code: 'day_closed',
        message: 'This check-in arrived after the day closed.',
      },
    ]);
    expect(deps.removeObject).toHaveBeenCalledWith('pact-1/user-1/item-1.jpg');
    expect(deps.deleteLocalFile).toHaveBeenCalledWith(PHOTO.fileUri);
    expect(deps.onSynced).not.toHaveBeenCalled();

    q.dismissNotice('item-1');
    expect(q.store.getState().notices).toEqual([]);
  });

  it('a rejected upload is permanent, not retried forever', async () => {
    const { deps } = fakeDeps({
      upload: jest.fn(async () => {
        throw new UploadRejected('403');
      }),
    });
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(PHOTO);
    await q.process();
    expect(q.store.getState().items).toEqual([]);
    expect(q.store.getState().notices[0].code).toBe('upload_rejected');
    expect(deps.checkIn).not.toHaveBeenCalled();
  });

  it('unknown server errors are retried', async () => {
    const { deps } = fakeDeps({ checkIn: jest.fn(async () => ({ error: { message: 'not_authenticated' } })) });
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(TAP);
    await q.process();
    expect(q.store.getState().items[0].attempts).toBe(1);
  });

  it('concurrent triggers (reconnect + foreground) share one run: check_in is called once', async () => {
    let release!: () => void;
    const checkIn = jest.fn(
      () => new Promise<{ error: null }>((resolve) => (release = () => resolve({ error: null }))),
    );
    const { deps } = fakeDeps({ checkIn });
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(TAP);

    const a = q.process();
    const b = q.process();
    const c = q.retryNow();
    await Promise.resolve();
    release();
    await Promise.all([a, b, c]);

    expect(checkIn).toHaveBeenCalledTimes(1);
  });

  it('retryNow makes backed-off items due immediately', async () => {
    const upload = jest.fn(async (): Promise<void> => networkDown());
    const { deps } = fakeDeps({ upload });
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(PHOTO);
    await q.process();
    upload.mockImplementation(async () => undefined);

    await q.retryNow();
    expect(q.store.getState().items).toEqual([]);
  });

  it('acceptance: airplane-mode check-in, app killed, reopened online -> syncs once', async () => {
    const storage = memoryStorage();

    // Offline: the check-in is queued and shown as done.
    const offline = fakeDeps({ upload: jest.fn(async () => networkDown()) });
    const before = createCheckInQueue(storage, offline.deps);
    before.enqueue(PHOTO);
    await before.process();
    expect(pendingCheckIn(before.store.getState(), 'pact-1', '2026-10-22')).toBeDefined();
    expect(offline.deps.checkIn).not.toHaveBeenCalled();

    // App killed. Reopened with a connection: the queue is restored before any sync.
    const online = fakeDeps();
    const after = createCheckInQueue(storage, online.deps);
    expect(pendingCheckIn(after.store.getState(), 'pact-1', '2026-10-22')).toMatchObject({ attempts: 1 });

    await after.retryNow();
    await after.process();
    await after.retryNow();

    expect(online.deps.upload).toHaveBeenCalledTimes(1);
    expect(online.deps.checkIn).toHaveBeenCalledTimes(1);
    expect(after.store.getState().items).toEqual([]);
    expect(JSON.parse(storage.data.get('check-in-queue')!).state.items).toEqual([]);
  });

  it('a newer capture for the same item id replaces the old one', () => {
    const { deps } = fakeDeps();
    const q = createCheckInQueue(memoryStorage(), deps);
    q.enqueue(PHOTO);
    q.enqueue({ ...PHOTO, note: 'retake' });
    expect(q.store.getState().items).toHaveLength(1);
    expect(q.store.getState().items[0].note).toBe('retake');
  });
});
