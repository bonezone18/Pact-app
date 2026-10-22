import { renderPush } from '../../supabase/functions/_shared/push-copy.ts';
import {
  type ClaimedRow,
  EXPO_PUSH_URL,
  type ExpoMessage,
  type ExpoTicket,
  postToExpo,
  sendDue,
  type SenderDeps,
} from '../../supabase/functions/_shared/push-sender.ts';

const PACT = 'p1';
const base = { pact_id: PACT, title: 'Walk 1 mile' };

describe('notification copy (spec table)', () => {
  it.each([
    ['reminder_am', { ...base, day: 4 }, 'Day 4 of Walk 1 mile. Lock it in early.', `/check-in/${PACT}`],
    ['partner_checked_in', { ...base, name: 'Bob', streak: 12 }, 'Bob just checked in. Your turn to keep 12 days alive.', `/check-in/${PACT}`],
    ['partner_checked_in', { ...base, name: 'Bob', streak: 1 }, 'Bob just checked in. Your turn to keep 1 day alive.', `/check-in/${PACT}`],
    ['partner_checked_in', { ...base, name: 'Bob', streak: 0 }, 'Bob just checked in. Your turn: today can be Day 1.', `/check-in/${PACT}`],
    ['locked', { ...base, name: 'Bob' }, 'Bob checked in. Walk 1 mile is locked for today.', '/'],
    ['reminder_pm', { ...base, name: 'Bob' }, '4 hours left. Bob is counting on you.', `/check-in/${PACT}`],
    ['reminder_late', { ...base, streak: 9 }, '1 hour until your 9-day streak resets for everyone.', `/check-in/${PACT}`],
    ['waiting', { ...base, name: 'Bob' }, "Bob hasn't checked in yet. Send a nudge?", '/'],
    ['nudge', { ...base, name: 'Bob' }, 'Bob nudged you: Walk 1 mile is waiting.', `/check-in/${PACT}`],
    ['milestone', { ...base, streak: 30 }, '30 days! Walk 1 mile hit a milestone.', '/'],
    ['broken', { ...base, streak_before: 18, streak: 0 }, 'The chain broke at 18 days. Day 1 starts now.', '/'],
    ['reaction', { ...base, name: 'Bob', kind: 'fire' }, 'Bob reacted 🔥 to your check-in.', '/'],
  ])('%s', (kind, payload, body, url) => {
    expect(renderPush(kind, payload)).toEqual({ title: 'Walk 1 mile', body, url });
  });

  it('unknown kinds render nothing', () => {
    expect(renderPush('something_new', base)).toBeNull();
  });

  it('falls back gracefully on missing fields', () => {
    expect(renderPush('nudge', {})).toEqual({ title: 'Lockstep', body: 'Your partner nudged you: Lockstep is waiting.', url: '/' });
  });
});

function row(id: number, tokens: string[], kind = 'nudge'): ClaimedRow {
  return { id, user_id: `u${id}`, kind, payload: { ...base, name: 'Bob' }, attempts: 1, tokens };
}

function deps(rows: ClaimedRow[][], post: (m: ExpoMessage[]) => Promise<ExpoTicket[]>) {
  const batches = [...rows];
  return {
    claim: jest.fn(async () => batches.shift() ?? []),
    markSent: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    dropTokens: jest.fn(async () => undefined),
    postToExpo: jest.fn(post),
  } satisfies SenderDeps;
}

const ok = (m: ExpoMessage[]): Promise<ExpoTicket[]> => Promise.resolve(m.map((_, i) => ({ status: 'ok', id: `t${i}` })));
const T = (s: string) => `ExponentPushToken[${s}]`;

describe('sender', () => {
  it('sends one message per device with the deep link, and marks the row sent', async () => {
    const d = deps([[row(1, [T('a'), T('b')])]], ok);
    const summary = await sendDue(d);

    expect(d.postToExpo).toHaveBeenCalledTimes(1);
    const messages = d.postToExpo.mock.calls[0][0];
    expect(messages.map((m) => m.to)).toEqual([T('a'), T('b')]);
    expect(messages[0]).toEqual({
      to: T('a'),
      title: 'Walk 1 mile',
      body: 'Bob nudged you: Walk 1 mile is waiting.',
      data: { url: `/check-in/${PACT}`, kind: 'nudge', pact_id: PACT },
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    });
    expect(d.markSent).toHaveBeenCalledWith([1]);
    expect(d.release).not.toHaveBeenCalled();
    expect(summary).toEqual({ claimed: 1, sent: 1, retried: 0, skipped: 0, droppedTokens: 0 });
  });

  it('batches at 100 messages per Expo request', async () => {
    const tokens = Array.from({ length: 250 }, (_, i) => T(String(i)));
    const d = deps([[row(1, tokens)]], ok);
    await sendDue(d);
    expect(d.postToExpo.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 50]);
  });

  it('drops DeviceNotRegistered tokens and still counts other devices', async () => {
    const d = deps([[row(1, [T('gone'), T('live')])]], async (m) =>
      m.map((msg) =>
        msg.to === T('gone')
          ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok', id: 'x' },
      ),
    );
    const summary = await sendDue(d);
    expect(d.dropTokens).toHaveBeenCalledWith([T('gone')]);
    expect(d.markSent).toHaveBeenCalledWith([1]);
    expect(summary.droppedTokens).toBe(1);
  });

  it('a row whose only device is gone is done, not retried', async () => {
    const d = deps([[row(1, [T('gone')])]], async () => [
      { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
    ]);
    await sendDue(d);
    expect(d.markSent).toHaveBeenCalledWith([1]);
    expect(d.release).not.toHaveBeenCalled();
  });

  it('other ticket errors release the row for a retry', async () => {
    const d = deps([[row(1, [T('a')]), row(2, [T('b')])]], async (m) =>
      m.map((msg) =>
        msg.to === T('a')
          ? { status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } }
          : { status: 'ok', id: 'x' },
      ),
    );
    const summary = await sendDue(d);
    expect(d.markSent).toHaveBeenCalledWith([2]);
    expect(d.release).toHaveBeenCalledWith([1], 'MessageRateExceeded');
    expect(summary).toMatchObject({ sent: 1, retried: 1 });
  });

  it('an Expo outage releases everything in that request', async () => {
    const d = deps([[row(1, [T('a')]), row(2, [T('b')])]], async () => {
      throw new Error('Expo push HTTP 503');
    });
    await sendDue(d);
    expect(d.release).toHaveBeenCalledWith([1, 2], 'Expo push HTTP 503');
    expect(d.markSent).not.toHaveBeenCalled();
  });

  it('rows with no devices, unknown kinds or malformed tokens are settled without a request', async () => {
    const d = deps([[row(1, []), row(2, [T('a')], 'mystery'), row(3, ['not-a-token'])]], ok);
    const summary = await sendDue(d);
    expect(d.postToExpo).not.toHaveBeenCalled();
    expect(d.markSent).toHaveBeenCalledWith([1, 2, 3]);
    expect(d.dropTokens).toHaveBeenCalledWith(['not-a-token']);
    expect(summary).toMatchObject({ sent: 0, skipped: 3 });
  });

  it('keeps claiming while full batches come back (backlog), up to the round limit', async () => {
    const full = Array.from({ length: 2 }, (_, i) => row(i + 1, [T(String(i))]));
    const d = deps([full, full, [row(9, [T('z')])], full], ok);
    const summary = await sendDue(d, { maxRows: 2 });
    expect(d.claim).toHaveBeenCalledTimes(3);
    expect(summary.claimed).toBe(5);
  });

  it('does nothing when nothing is due', async () => {
    const d = deps([[]], ok);
    expect(await sendDue(d)).toEqual({ claimed: 0, sent: 0, retried: 0, skipped: 0, droppedTokens: 0 });
    expect(d.markSent).not.toHaveBeenCalled();
  });
});

describe('Expo request', () => {
  const message = { to: T('a'), title: 't', body: 'b', data: { url: '/', kind: 'nudge' }, sound: 'default', priority: 'high', channelId: 'default' } as const;

  it('posts JSON to Expo with the access token when set', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({ data: [{ status: 'ok', id: '1' }] })));
    expect(await postToExpo([message], { accessToken: 'secret', fetch })).toEqual([{ status: 'ok', id: '1' }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EXPO_PUSH_URL);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual([message]);
  });

  it('throws on HTTP errors and on malformed responses (so the batch is retried)', async () => {
    await expect(postToExpo([message], { fetch: async () => new Response('', { status: 500 }) })).rejects.toThrow('HTTP 500');
    await expect(
      postToExpo([message], { fetch: async () => new Response(JSON.stringify({ errors: [{ message: 'bad' }] })) }),
    ).rejects.toThrow('bad');
  });
});
