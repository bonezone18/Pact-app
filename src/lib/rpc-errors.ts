// Server error codes (raised by the game RPCs) and the copy shown for them.
const MESSAGES: Record<string, string> = {
  invalid_code: "That invite code doesn't exist or was replaced. Ask for a fresh link.",
  expired_code: 'That invite expired. Ask your partner to send a new one.',
  pact_full: 'That pact is already full.',
  already_member: "You're already in this pact.",
  pro_required: 'This needs Pact Pro.',
  not_member: "You're not a member of this pact.",
  pact_inactive: "This pact isn't active.",
  invalid_title: 'Give your pact a title of up to 40 characters.',
  invalid_pod_size: 'Pacts have 2 to 4 members.',
  not_authenticated: 'Please sign in again.',
};

export type RpcError = { code: string; message: string };

/** Turns a Supabase/PostgREST error into a known code plus user-facing copy. */
export function toRpcError(error: unknown): RpcError {
  const raw =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  const code = raw in MESSAGES ? raw : 'unknown';
  return { code, message: MESSAGES[code] ?? 'Something went wrong. Please try again.' };
}
