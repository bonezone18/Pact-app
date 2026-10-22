// Drains notification_outbox through Expo Push. Pure logic with injected I/O,
// shared by the Edge Function (Deno) and the Jest tests.

import { renderPush } from './push-copy.ts';

export type ClaimedRow = {
  id: number;
  user_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  tokens: string[];
};

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: { url: string; kind: string; pact_id?: string };
  sound: 'default';
  priority: 'high';
  channelId: 'default';
};

export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export type SenderDeps = {
  claim(maxRows: number): Promise<ClaimedRow[]>;
  markSent(ids: number[]): Promise<void>;
  release(ids: number[], error: string): Promise<void>;
  dropTokens(tokens: string[]): Promise<void>;
  /** One request to Expo; throws if the request itself fails. */
  postToExpo(messages: ExpoMessage[]): Promise<ExpoTicket[]>;
};

export type SendSummary = { claimed: number; sent: number; retried: number; skipped: number; droppedTokens: number };

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_BATCH = 100;
const TOKEN_RE = /^Expo(nent)?PushToken\[.+\]$/;

export async function postToExpo(
  messages: ExpoMessage[],
  opts: { accessToken?: string; fetch?: typeof fetch } = {},
): Promise<ExpoTicket[]> {
  const res = await (opts.fetch ?? fetch)(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}),
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
  const json = (await res.json()) as { data?: ExpoTicket[]; errors?: { message: string }[] };
  if (!Array.isArray(json.data) || json.data.length !== messages.length) {
    throw new Error(`Expo push: ${json.errors?.[0]?.message ?? 'unexpected response'}`);
  }
  return json.data;
}

type Outcome = { ok: number; errors: string[] };

/**
 * One sender run: claim due rows, send, then settle each row.
 * A row is sent if any device accepted it; retried (up to its attempt limit)
 * if delivery failed for another reason; done if it had nowhere to go.
 */
export async function sendDue(deps: SenderDeps, opts: { maxRows?: number; maxRounds?: number } = {}): Promise<SendSummary> {
  const maxRows = opts.maxRows ?? 100;
  const maxRounds = opts.maxRounds ?? 5;
  const summary: SendSummary = { claimed: 0, sent: 0, retried: 0, skipped: 0, droppedTokens: 0 };

  for (let round = 0; round < maxRounds; round++) {
    const rows = await deps.claim(maxRows);
    summary.claimed += rows.length;

    const skipped: number[] = [];
    const outcomes = new Map<number, Outcome>();
    const dead: string[] = [];
    const queue: { rowId: number; message: ExpoMessage }[] = [];

    for (const row of rows) {
      const push = renderPush(row.kind, row.payload);
      const tokens = row.tokens.filter((t) => TOKEN_RE.test(t));
      dead.push(...row.tokens.filter((t) => !TOKEN_RE.test(t)));
      if (!push || tokens.length === 0) {
        skipped.push(row.id); // unknown kind, or no devices: nothing to deliver
        continue;
      }
      outcomes.set(row.id, { ok: 0, errors: [] });
      const pactId = typeof row.payload.pact_id === 'string' ? row.payload.pact_id : undefined;
      for (const to of tokens) {
        queue.push({
          rowId: row.id,
          message: {
            to,
            title: push.title,
            body: push.body,
            data: { url: push.url, kind: row.kind, ...(pactId ? { pact_id: pactId } : {}) },
            sound: 'default',
            priority: 'high',
            channelId: 'default',
          },
        });
      }
    }

    for (let i = 0; i < queue.length; i += EXPO_BATCH) {
      const batch = queue.slice(i, i + EXPO_BATCH);
      try {
        const tickets = await deps.postToExpo(batch.map((b) => b.message));
        tickets.forEach((ticket, j) => {
          const { rowId, message } = batch[j];
          const outcome = outcomes.get(rowId)!;
          if (ticket.status === 'ok') outcome.ok++;
          else if (ticket.details?.error === 'DeviceNotRegistered') dead.push(message.to);
          else outcome.errors.push(ticket.details?.error ?? ticket.message);
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        for (const { rowId } of batch) outcomes.get(rowId)!.errors.push(reason);
      }
    }

    const sent: number[] = [];
    const retry: number[] = [];
    const reasons: string[] = [];
    for (const [rowId, outcome] of outcomes) {
      // errors.length === 0 without ok: every device was gone; nothing left to try.
      if (outcome.ok > 0 || outcome.errors.length === 0) sent.push(rowId);
      else {
        retry.push(rowId);
        reasons.push(outcome.errors[0]);
      }
    }

    const done = [...sent, ...skipped];
    if (done.length) await deps.markSent(done);
    if (retry.length) await deps.release(retry, [...new Set(reasons)].join('; '));
    const uniqueDead = [...new Set(dead)];
    if (uniqueDead.length) await deps.dropTokens(uniqueDead);

    summary.sent += sent.length;
    summary.skipped += skipped.length;
    summary.retried += retry.length;
    summary.droppedTokens += uniqueDead.length;

    if (rows.length < maxRows) break;
  }
  return summary;
}
