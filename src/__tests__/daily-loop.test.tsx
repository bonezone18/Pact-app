import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import type { CheckInQueue } from '@/lib/check-in-queue';
import { queryClient } from '@/lib/query-client';
import type { Today } from '@/lib/today';
import { fake } from '@/test/fake-supabase';
import { doneCheckIn, member, today } from '@/test/today-fixtures';

jest.mock('@/lib/supabase', () => ({ supabase: require('@/test/fake-supabase').fake.client }));
jest.mock('@/lib/timezone', () => ({ syncTimezone: jest.fn(async () => undefined) }));
jest.mock('@/lib/auth', () => ({ SignInCancelled: class extends Error {}, signOut: jest.fn() }));

// The real queue, on a storage that survives "app restarts", talking to the
// fake Supabase. Syncs are triggered explicitly by the tests.
const mockQueueStorage = new Map<string, string>();
jest.mock('@/lib/check-in-sync', () => {
  const { createCheckInQueue } = require('@/lib/check-in-queue');
  const { fake: f } = require('@/test/fake-supabase');
  const { queryClient: qc } = require('@/lib/query-client');
  const make = () =>
    createCheckInQueue(
      {
        getItem: (k: string) => mockQueueStorage.get(k) ?? null,
        setItem: (k: string, v: string) => mockQueueStorage.set(k, v),
        removeItem: (k: string) => mockQueueStorage.delete(k),
      },
      {
        upload: async (path: string) => {
          const { error } = await f.client.storage.from('proofs').upload(path, new Uint8Array(), { upsert: true });
          if (error) throw error;
        },
        checkIn: async (args: object) => {
          const { error } = await f.client.rpc('check_in', args);
          return { error };
        },
        removeObject: async (p: string) => {
          await f.client.storage.from('proofs').remove([p]);
        },
        deleteLocalFile: () => undefined,
        now: () => Date.now(),
        onSynced: (item: { pactId: string }) => qc.invalidateQueries({ queryKey: ['pact-today', item.pactId] }),
      },
    );
  return {
    make,
    checkInQueue: make(),
    persistProof: (_uri: string, id: string) => `file:///docs/proof-queue/${id}.jpg`,
    useCheckInSync: () => undefined,
  };
});

jest.mock('expo-camera', () => {
  const React = require('react');
  return {
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
    CameraView: React.forwardRef(function MockCameraView(_props: object, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({
        takePictureAsync: async () => ({ uri: 'file:///cache/raw.jpg', width: 3024, height: 4032 }),
      }));
      return null;
    }),
  };
});
jest.mock('@/lib/proof-image', () => ({ prepareProof: jest.fn(async () => 'file:///cache/proof.jpg') }));

const sync = require('@/lib/check-in-sync') as { checkInQueue: CheckInQueue; make: () => CheckInQueue };
const { client, controls, storageApi } = fake;
const APP = 'src/app';

// Server state for pact_today, which tests edit as the "server" changes.
let server: Today;
type Handler = (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null };
let handlers: Record<string, Handler>;

function serverMarksMeDone() {
  server = {
    ...server,
    members: server.members.map((m) => (m.is_me ? { ...m, state: 'done', check_in: doneCheckIn('c-me') } : m)),
  };
}

beforeEach(() => {
  controls.reset();
  queryClient.clear();
  mockQueueStorage.clear();
  sync.checkInQueue = sync.make();
  controls.signIn('user-1');
  controls.setTable('pacts', [{ id: 'p1', title: 'Walk 1 mile', status: 'active', proof_mode: 'tap', current_streak: 3, pact_members: [] }]);

  const ends = new Date(Date.now() + ((4 * 60 + 32) * 60 + 30) * 1000).toISOString();
  server = today({}, [
    member({ user_id: 'user-1', display_name: 'Alice', is_me: true, role: 'owner', day_ends_at: ends }),
    member({ user_id: 'user-2', display_name: 'Bob', state: 'done', check_in: doneCheckIn('c-bob', 'p1/user-2/b.jpg'), day_ends_at: ends }),
  ]);
  handlers = {
    pact_today: () => ({ data: server }),
    check_in: () => {
      serverMarksMeDone();
      return { data: { check_in_id: 'c-me', local_date: server.date } };
    },
  };
  client.rpc.mockImplementation(async (fn: string, args?: unknown) => {
    const h = handlers[fn];
    const r = h ? h((args ?? {}) as Record<string, unknown>) : {};
    return { data: r.data ?? null, error: r.error ?? null };
  });
});

const myRow = () => screen.getByRole('button', { name: /^You, / });
const findMyRow = () => screen.findByRole('button', { name: /^You, / });

describe('dashboard', () => {
  it('shows the hero streak, member badges, my countdown and "Check in"', async () => {
    await renderRouter(APP, { initialUrl: '/' });
    expect(await screen.findByText('3')).toBeTruthy();
    expect(screen.getByText('DAYS')).toBeTruthy();
    expect(myRow().props.accessibilityLabel).toBe('You, PENDING');
    expect(screen.getByRole('button', { name: 'Bob, DONE' })).toBeTruthy();
    expect(screen.getByTestId('countdown')).toHaveTextContent('04h 32m left');
    expect(screen.getByRole('button', { name: 'Check in' })).toBeEnabled();
    expect(client.rpc).toHaveBeenCalledWith('pact_today', { pact_id: 'p1' });
  });

  it('shows the partner photo thumbnail via a signed URL and opens the proof', async () => {
    await renderRouter(APP, { initialUrl: '/' });
    const thumb = await screen.findByRole('imagebutton', { name: 'Open proof' });
    expect(storageApi.createSignedUrls).toHaveBeenCalledWith(['p1/user-2/b.jpg'], 3600);
    await fireEvent.press(thumb);
    expect(await screen.findByLabelText('Close proof')).toBeTruthy();
  });

  it('a broken streak reads grey "0 DAYS — Day 1 starts now"', async () => {
    server = { ...server, pact: { ...server.pact, current_streak: 0 } };
    await renderRouter(APP, { initialUrl: '/' });
    expect(await screen.findByText('DAYS — Day 1 starts now')).toBeTruthy();
  });

  it('"Waiting on Bob" with Bob\'s time left once I am done', async () => {
    server = {
      ...server,
      members: [
        { ...server.members[0], state: 'done', check_in: doneCheckIn('c-me') },
        { ...server.members[1], state: 'pending', check_in: null, day_ends_at: new Date(Date.now() + 2 * 3600_000 + 30_000).toISOString() },
      ],
    };
    await renderRouter(APP, { initialUrl: '/' });
    expect(await screen.findByRole('button', { name: 'Waiting on Bob' })).toBeDisabled();
    expect(screen.getByTestId('countdown')).toHaveTextContent('Bob: 02h 00m left');
  });

  it('"Locked for today" when everyone is in', async () => {
    serverMarksMeDone();
    await renderRouter(APP, { initialUrl: '/' });
    expect(await screen.findByRole('button', { name: 'Locked for today' })).toBeDisabled();
    expect(screen.queryByTestId('countdown')).toBeNull();
  });

  it('"Day 1 starts at midnight" across the date line', async () => {
    server = { ...server, not_started: true };
    await renderRouter(APP, { initialUrl: '/' });
    expect(await screen.findByRole('button', { name: 'Day 1 starts at midnight' })).toBeDisabled();
  });

  it('refetches when a partner checks in (realtime)', async () => {
    server = { ...server, members: [server.members[0], { ...server.members[1], state: 'pending', check_in: null }] };
    await renderRouter(APP, { initialUrl: '/' });
    expect(await screen.findByRole('button', { name: 'Bob, PENDING' })).toBeTruthy();
    expect(client.channel).toHaveBeenCalledWith('pact:p1');

    server = { ...server, members: [server.members[0], { ...server.members[1], state: 'done', check_in: doneCheckIn('c-bob') }] };
    await act(async () => controls.emit('check_ins', { pact_id: 'p1' }));
    expect(await screen.findByRole('button', { name: 'Bob, DONE' })).toBeTruthy();
  });
});

describe('check-in', () => {
  it('tap mode: Done -> instantly DONE (syncing) -> synced', async () => {
    const app = await renderRouter(APP, { initialUrl: '/' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(app.getPathname()).toBe('/check-in/p1'));

    await fireEvent.changeText(screen.getByLabelText('Note'), '  first mile  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    expect(myRow().props.accessibilityLabel).toBe('You, DONE · syncing');
    expect(sync.checkInQueue.store.getState().items[0]).toMatchObject({ pactId: 'p1', userId: 'user-1', note: 'first mile', fileUri: null, forDate: '2026-10-22' });

    await act(() => sync.checkInQueue.process());
    expect(client.rpc).toHaveBeenCalledWith('check_in', expect.objectContaining({ pact_id: 'p1', image_path: null, note: 'first mile' }));
    await waitFor(() => expect(myRow().props.accessibilityLabel).toBe('You, DONE'));
    expect(screen.getByRole('button', { name: 'Locked for today' })).toBeTruthy();
  });

  it('photo mode: live clock in the viewfinder, capture, note, upload under my prefix, then check_in', async () => {
    server = { ...server, pact: { ...server.pact, proof_mode: 'photo' } };
    const app = await renderRouter(APP, { initialUrl: '/check-in/p1' });

    expect(await screen.findByTestId('viewfinder-clock')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Take photo' }));
    await fireEvent.changeText(await screen.findByLabelText('Note'), 'sunrise');
    await fireEvent.press(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(app.getPathname()).toBe('/'));

    const queued = sync.checkInQueue.store.getState().items[0];
    expect(queued.fileUri).toBe(`file:///docs/proof-queue/${queued.id}.jpg`);
    await act(() => sync.checkInQueue.process());
    expect(storageApi.upload).toHaveBeenCalledWith(`p1/user-1/${queued.id}.jpg`, expect.anything(), { upsert: true });
    expect(client.rpc).toHaveBeenCalledWith('check_in', expect.objectContaining({ image_path: `p1/user-1/${queued.id}.jpg`, note: 'sunrise' }));
  });

  it('acceptance: airplane-mode check-in, app killed, reopened online -> syncs once, UI shows done throughout', async () => {
    // Offline: the RPC can't reach the server.
    handlers.check_in = () => ({ error: { message: 'TypeError: Network request failed' } });
    const first = await renderRouter(APP, { initialUrl: '/check-in/p1' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(first.getPathname()).toBe('/'));
    await act(() => sync.checkInQueue.process());
    expect((await findMyRow()).props.accessibilityLabel).toBe('You, DONE · syncing');

    // App killed: everything in memory is gone except MMKV.
    await first.unmount();
    queryClient.clear();
    sync.checkInQueue = sync.make();
    let checkInCalls = 0;
    handlers.check_in = () => {
      checkInCalls++;
      serverMarksMeDone();
      return { data: { check_in_id: 'c-me', local_date: server.date } };
    };

    // Reopened online: done before the sync, during it, and after it.
    await renderRouter(APP, { initialUrl: '/' });
    await screen.findByText('3');
    expect(myRow().props.accessibilityLabel).toBe('You, DONE · syncing');
    await act(() => sync.checkInQueue.retryNow());
    await act(() => sync.checkInQueue.retryNow());
    await waitFor(() => expect(myRow().props.accessibilityLabel).toBe('You, DONE'));
    expect(checkInCalls).toBe(1);
  });

  it('day_closed: the optimistic DONE is cleared and the reason is shown', async () => {
    handlers.check_in = () => ({ error: { message: 'day_closed' } });
    const app = await renderRouter(APP, { initialUrl: '/check-in/p1' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    await act(() => sync.checkInQueue.process());

    expect(await screen.findByText('This check-in arrived after the day closed.')).toBeTruthy();
    expect(myRow().props.accessibilityLabel).toBe('You, PENDING');
  });

  it('already_checked_in on a retry is treated as success', async () => {
    handlers.check_in = () => {
      serverMarksMeDone();
      return { error: { message: 'already_checked_in' } };
    };
    const app = await renderRouter(APP, { initialUrl: '/check-in/p1' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    await act(() => sync.checkInQueue.process());
    await waitFor(() => expect(myRow().props.accessibilityLabel).toBe('You, DONE'));
    expect(screen.queryByText(/couldn't be saved/)).toBeNull();
  });

  it('the check-in screen refuses a second check-in for the day', async () => {
    serverMarksMeDone();
    await renderRouter(APP, { initialUrl: '/check-in/p1' });
    expect(await screen.findByText("You're checked in for today")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });
});

describe('nudges and reactions', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => {
    // Press the confirm button of whatever alert opens.
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.style !== 'cancel')?.onPress?.();
    });
    server = { ...server, members: [server.members[0], { ...server.members[1], state: 'pending', check_in: null }] };
  });
  afterEach(() => alertSpy.mockRestore());

  it('tapping a pending partner nudges them', async () => {
    handlers.nudge = () => ({ data: null });
    await renderRouter(APP, { initialUrl: '/' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Bob, PENDING' }));
    expect(alertSpy.mock.calls[0][0]).toBe('Nudge Bob?');
    expect(await screen.findByText('Nudged Bob.')).toBeTruthy();
    expect(client.rpc).toHaveBeenCalledWith('nudge', { pact_id: 'p1', user_id: 'user-2' });
  });

  it('a third nudge is refused by the server and explained', async () => {
    handlers.nudge = () => ({ error: { message: 'rate_limited' } });
    await renderRouter(APP, { initialUrl: '/' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Bob, PENDING' }));
    expect(await screen.findByText("You've used both nudges for today.")).toBeTruthy();
  });

  it('no nudge prompt once both nudges are used', async () => {
    server = { ...server, nudges_left: 0 };
    await renderRouter(APP, { initialUrl: '/' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Bob, PENDING' }));
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getByText("You've used both nudges for today.")).toBeTruthy();
  });

  it('tapping a done partner opens the reactions and sends one', async () => {
    server = { ...server, members: [server.members[0], { ...server.members[1], state: 'done', check_in: doneCheckIn('c-bob') }] };
    handlers.react = () => ({ data: null });
    await renderRouter(APP, { initialUrl: '/' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Bob, DONE' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'React fire' }));
    expect(client.rpc).toHaveBeenCalledWith('react', { check_in_id: 'c-bob', kind: 'fire' });
  });

  it('reactions on my check-in show on my row', async () => {
    server = {
      ...server,
      members: [
        { ...server.members[0], state: 'done', check_in: { ...doneCheckIn('c-me'), reactions: [{ user_id: 'user-2', kind: 'clap' }] } },
        server.members[1],
      ],
    };
    await renderRouter(APP, { initialUrl: '/' });
    expect(await screen.findByText('👏')).toBeTruthy();
  });
});

describe('history', () => {
  it('shows the month calendar (green extended, grey missed), longest streak and photo log', async () => {
    controls.setTable('pacts', { title: 'Walk 1 mile', current_streak: 3, longest_streak: 9, start_date: '2026-10-01' });
    controls.setTable('streak_events', [
      { local_date: '2026-10-01', outcome: 'extended' },
      { local_date: '2026-10-02', outcome: 'broken' },
    ]);
    controls.setTable('check_ins', [
      { id: 'c1', user_id: 'user-2', local_date: '2026-10-01', image_path: 'p1/user-2/a.jpg', note: null, profiles: { display_name: 'Bob' } },
      { id: 'c2', user_id: 'user-1', local_date: '2026-10-01', image_path: null, note: null, profiles: { display_name: 'Alice' } },
    ]);
    jest.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    await renderRouter(APP, { initialUrl: '/pact/p1' });

    expect(await screen.findByText('Current 3 · Longest 9')).toBeTruthy();
    expect(screen.getByLabelText('2026-10-01, extended')).toBeTruthy();
    expect(screen.getByLabelText('2026-10-02, missed')).toBeTruthy();
    expect(screen.getByLabelText('2026-10-03')).toBeTruthy();
    expect(screen.getByLabelText('Bob, 2026-10-01')).toBeTruthy();
    expect(screen.queryByLabelText('Alice, 2026-10-01')).toBeNull();
  });
});
