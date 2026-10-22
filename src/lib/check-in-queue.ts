import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createStore, type StoreApi } from 'zustand/vanilla';

// The check-in pipeline: the UI marks a check-in done instantly and a
// persistent queue does the rest — upload the photo, then call check_in.
// Upload and insert are two steps, so every step is safe to repeat: the
// object path is the queue item's id (retries overwrite it) and the server
// answers a repeated check_in with already_checked_in, which counts as done.

export type QueueItem = {
  id: string;
  pactId: string;
  userId: string;
  /** The server's date for the user when they checked in; drives the optimistic DONE. */
  forDate: string;
  /** Local JPEG (photo mode) or null (tap mode). */
  fileUri: string | null;
  note: string | null;
  capturedAt: string;
  /** Set once the photo is in storage, so a retry skips straight to check_in. */
  imagePath: string | null;
  attempts: number;
  nextAttemptAt: number;
};

export type QueueNotice = { id: string; pactId: string; forDate: string; code: string; message: string };

export type CheckInArgs = {
  pact_id: string;
  image_path: string | null;
  note: string | null;
  captured_at: string;
};

export type QueueDeps = {
  /** Uploads the local file to proofs/<path> (upsert). Throws UploadRejected for 4xx. */
  upload(path: string, fileUri: string): Promise<void>;
  checkIn(args: CheckInArgs): Promise<{ error: { message: string } | null }>;
  removeObject(path: string): Promise<void>;
  deleteLocalFile(uri: string): void;
  now(): number;
  onSynced?(item: QueueItem): void;
};

/** The storage service refused the upload; retrying won't help. */
export class UploadRejected extends Error {}

/** Server answers that mean "this check-in will never land". */
const PERMANENT = new Set([
  'day_closed',
  'not_member',
  'pact_inactive',
  'photo_required',
  'invalid_image_path',
  'note_too_long',
  'not_started',
  'upload_rejected',
]);

const NOTICE_COPY: Record<string, string> = {
  day_closed: 'This check-in arrived after the day closed.',
  not_started: 'Day 1 has not started yet, so this check-in was not counted.',
};

export const BASE_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 5 * 60_000;

export function backoff(attempts: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

type QueueState = {
  items: QueueItem[];
  notices: QueueNotice[];
};

export type CheckInQueue = {
  store: StoreApi<QueueState>;
  enqueue(item: Omit<QueueItem, 'attempts' | 'nextAttemptAt' | 'imagePath'>): void;
  /** Works through every due item once. Concurrent calls share one run. */
  process(): Promise<void>;
  /** Makes every item due now (reconnect, app foreground). */
  retryNow(): Promise<void>;
  dismissNotice(id: string): void;
  /** Milliseconds until the next item is due, or null when nothing is waiting. */
  nextDueIn(): number | null;
};

export function createCheckInQueue(storage: StateStorage, deps: QueueDeps): CheckInQueue {
  const store = createStore<QueueState>()(
    persist<QueueState>(() => ({ items: [], notices: [] }), {
      name: 'check-in-queue',
      storage: createJSONStorage(() => storage),
    }),
  );

  const patch = (id: string, changes: Partial<QueueItem>) =>
    store.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...changes } : i)) }));

  const drop = (item: QueueItem) => {
    store.setState((s) => ({ items: s.items.filter((i) => i.id !== item.id) }));
    if (item.fileUri) {
      try {
        deps.deleteLocalFile(item.fileUri);
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  };

  const giveUp = async (item: QueueItem, code: string) => {
    drop(item);
    const notice: QueueNotice = {
      id: item.id,
      pactId: item.pactId,
      forDate: item.forDate,
      code,
      message: NOTICE_COPY[code] ?? "Your check-in couldn't be saved. Please check in again.",
    };
    store.setState((s) => ({ notices: [...s.notices, notice] }));
    // The orphan photo has no check-in pointing at it; the nightly job is the backstop.
    if (item.imagePath) await deps.removeObject(item.imagePath).catch(() => undefined);
  };

  const processItem = async (item: QueueItem) => {
    let imagePath = item.imagePath;
    try {
      if (item.fileUri && !imagePath) {
        const path = `${item.pactId}/${item.userId}/${item.id}.jpg`;
        await deps.upload(path, item.fileUri);
        imagePath = path;
        patch(item.id, { imagePath });
      }
      const { error } = await deps.checkIn({
        pact_id: item.pactId,
        image_path: imagePath,
        note: item.note,
        captured_at: item.capturedAt,
      });
      // already_checked_in: a previous attempt landed but its reply was lost.
      if (!error || error.message === 'already_checked_in') {
        drop(item);
        deps.onSynced?.(item);
        return;
      }
      if (PERMANENT.has(error.message)) {
        await giveUp({ ...item, imagePath }, error.message);
        return;
      }
      throw new Error(error.message);
    } catch (e) {
      if (e instanceof UploadRejected) {
        await giveUp(item, 'upload_rejected');
        return;
      }
      const attempts = item.attempts + 1;
      patch(item.id, { attempts, nextAttemptAt: deps.now() + backoff(attempts) });
    }
  };

  let running: Promise<void> | null = null;

  const process = () => {
    if (running) return running;
    const run = (async () => {
      const due = store
        .getState()
        .items.filter((i) => i.nextAttemptAt <= deps.now())
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      for (const item of due) {
        // Re-read: an earlier step may have updated it.
        const current = store.getState().items.find((i) => i.id === item.id);
        if (current) await processItem(current);
      }
    })();
    // Cleared after assignment: with nothing due the run finishes synchronously.
    const guarded: Promise<void> = run.finally(() => {
      if (running === guarded) running = null;
    });
    running = guarded;
    return guarded;
  };

  return {
    store,
    enqueue(item) {
      store.setState((s) => ({
        items: [...s.items.filter((i) => i.id !== item.id), { ...item, imagePath: null, attempts: 0, nextAttemptAt: 0 }],
      }));
    },
    process,
    async retryNow() {
      store.setState((s) => ({ items: s.items.map((i) => ({ ...i, nextAttemptAt: 0 })) }));
      await process();
    },
    dismissNotice(id) {
      store.setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
    },
    nextDueIn() {
      const items = store.getState().items;
      if (items.length === 0) return null;
      const next = Math.min(...items.map((i) => i.nextAttemptAt));
      return Math.max(0, next - deps.now());
    },
  };
}

/** Is there a not-yet-synced check-in for this pact and date? */
export function pendingCheckIn(state: QueueState, pactId: string, forDate: string): QueueItem | undefined {
  return state.items.find((i) => i.pactId === pactId && i.forDate === forDate);
}
