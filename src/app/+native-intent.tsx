import { inviteCodeFromUrl } from '@/lib/invite-code';

// Universal links (https://lockstep.app/j/K7MQ2X) and lockstep://j/K7MQ2X open the
// join screen directly.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const code = inviteCodeFromUrl(path);
  return code ? `/join/${code}` : path;
}
