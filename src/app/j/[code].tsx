import { Redirect, useLocalSearchParams } from 'expo-router';

import { normalizeInviteCode } from '@/lib/invite-code';

// Fallback for /j/<code> links that reach the router without +native-intent.
export default function InviteLinkRedirect() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <Redirect href={`/join/${normalizeInviteCode(code ?? '')}`} />;
}
