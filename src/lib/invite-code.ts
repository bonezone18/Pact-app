// Invite codes: 6 characters from an alphabet without 0/O, 1/I/L.
// Stored as K7MQ2X, shown as K7M-Q2X.

export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;

export const LINK_HOST = process.env.EXPO_PUBLIC_LINK_HOST ?? 'lockstep.app';

/** Uppercases and strips spaces/hyphens. Does not validate. */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isInviteCode(input: string): boolean {
  return CODE_RE.test(normalizeInviteCode(input));
}

export function formatInviteCode(code: string): string {
  const c = normalizeInviteCode(code);
  return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

export function inviteUrl(code: string): string {
  return `https://${LINK_HOST}/j/${normalizeInviteCode(code)}`;
}

/**
 * Finds an invite code in pasted or clipboard text: a bare code, the display
 * form, or an invite link. Returns null unless it matches the format exactly.
 */
export function extractInviteCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const fromLink = trimmed.match(/\/j\/([A-Za-z0-9-]{6,7})(?:[/?#]|$)/);
  const candidate = normalizeInviteCode(fromLink ? fromLink[1] : trimmed);
  return CODE_RE.test(candidate) ? candidate : null;
}

export function inviteShareMessage(code: string, title: string): string {
  return `Start a streak with me on Lockstep: "${title}". We both check in every day; miss one and it resets for both of us. Code ${formatInviteCode(code)}\n${inviteUrl(code)}`;
}

/**
 * The invite code in an incoming link: https://lockstep.app/j/K7MQ2X,
 * lockstep://j/K7MQ2X or a bare /j/K7MQ2X path. Null for anything else.
 */
export function inviteCodeFromUrl(url: string): string | null {
  const m = url.match(/\/j\/([^/?#]+)/);
  if (!m) return null;
  const code = normalizeInviteCode(m[1]);
  return CODE_RE.test(code) ? code : null;
}
