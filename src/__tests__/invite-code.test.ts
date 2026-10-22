import {
  extractInviteCode,
  formatInviteCode,
  inviteCodeFromUrl,
  inviteShareMessage,
  inviteUrl,
  isInviteCode,
  normalizeInviteCode,
} from '@/lib/invite-code';

describe('invite codes', () => {
  it('normalizes the display form', () => {
    expect(normalizeInviteCode('k7m-q2x')).toBe('K7MQ2X');
    expect(normalizeInviteCode(' K7M Q2X ')).toBe('K7MQ2X');
  });

  it('formats with a display-only hyphen', () => {
    expect(formatInviteCode('K7MQ2X')).toBe('K7M-Q2X');
    expect(formatInviteCode('k7m')).toBe('K7M');
  });

  it('accepts only the unambiguous alphabet', () => {
    expect(isInviteCode('K7M-Q2X')).toBe(true);
    for (const bad of ['K7M0QX', 'K7MOQX', 'K7M1QX', 'K7MIQX', 'K7MLQX', 'K7MQ2', 'K7MQ2XA']) {
      expect(isInviteCode(bad)).toBe(false);
    }
  });

  it('finds a code in clipboard text: bare, display form or link', () => {
    expect(extractInviteCode('K7MQ2X')).toBe('K7MQ2X');
    expect(extractInviteCode('  k7m-q2x\n')).toBe('K7MQ2X');
    expect(extractInviteCode('https://lockstep.app/j/K7MQ2X')).toBe('K7MQ2X');
    expect(extractInviteCode('Join my streak https://lockstep.app/j/K7MQ2X?ref=sms')).toBe('K7MQ2X');
  });

  it('ignores clipboard text that does not match the format', () => {
    expect(extractInviteCode(null)).toBeNull();
    expect(extractInviteCode('')).toBeNull();
    expect(extractInviteCode('hello world')).toBeNull();
    expect(extractInviteCode('K7M0QX')).toBeNull();
    expect(extractInviteCode('call me at 555-1234')).toBeNull();
  });

  it('reads codes from incoming links', () => {
    expect(inviteCodeFromUrl('https://lockstep.app/j/K7MQ2X')).toBe('K7MQ2X');
    expect(inviteCodeFromUrl('lockstep://j/k7mq2x')).toBe('K7MQ2X');
    expect(inviteCodeFromUrl('/j/K7M-Q2X')).toBe('K7MQ2X');
    expect(inviteCodeFromUrl('https://lockstep.app/j/NOPE')).toBeNull();
    expect(inviteCodeFromUrl('/settings')).toBeNull();
  });

  it('builds the share link and message', () => {
    expect(inviteUrl('k7m-q2x')).toBe('https://lockstep.app/j/K7MQ2X');
    const msg = inviteShareMessage('K7MQ2X', 'Walk 1 mile');
    expect(msg).toContain('"Walk 1 mile"');
    expect(msg).toContain('K7M-Q2X');
    expect(msg).toContain('https://lockstep.app/j/K7MQ2X');
  });
});
