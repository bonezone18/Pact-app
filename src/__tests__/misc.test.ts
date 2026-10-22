import { redirectSystemPath } from '@/app/+native-intent';
import { toRpcError } from '@/lib/rpc-errors';
import { routeForIntent, useOnboarding } from '@/stores/onboarding';

describe('universal links', () => {
  it.each([
    ['https://lockstep.app/j/K7MQ2X', '/join/K7MQ2X'],
    ['lockstep://j/k7m-q2x', '/join/K7MQ2X'],
    ['/j/K7MQ2X', '/join/K7MQ2X'],
  ])('%s opens the join screen', (path, expected) => {
    expect(redirectSystemPath({ path, initial: true })).toBe(expected);
  });

  it('leaves other paths alone', () => {
    expect(redirectSystemPath({ path: '/create', initial: false })).toBe('/create');
    expect(redirectSystemPath({ path: 'https://lockstep.app/j/BAD', initial: true })).toBe('https://lockstep.app/j/BAD');
  });
});

describe('rpc errors', () => {
  it('maps server codes to copy', () => {
    expect(toRpcError({ message: 'expired_code' })).toEqual({
      code: 'expired_code',
      message: 'That invite expired. Ask your partner to send a new one.',
    });
    expect(toRpcError({ message: 'pact_full' }).code).toBe('pact_full');
  });

  it('never leaks unknown server messages', () => {
    expect(toRpcError({ message: 'relation "x" does not exist' })).toEqual({
      code: 'unknown',
      message: 'Something went wrong. Please try again.',
    });
    expect(toRpcError(new Error('network')).code).toBe('unknown');
  });
});

describe('onboarding intent', () => {
  it('resumes the right screen after sign-in', () => {
    expect(routeForIntent(null)).toBe('/');
    expect(routeForIntent({ kind: 'create' })).toBe('/create');
    expect(routeForIntent({ kind: 'join', code: 'K7MQ2X' })).toBe('/join/K7MQ2X');
  });

  it('writes the intent to MMKV so it survives an app restart', async () => {
    useOnboarding.getState().setIntent({ kind: 'join', code: 'K7MQ2X' });
    const saved = await useOnboarding.persist.getOptions().storage?.getItem('onboarding');
    expect(saved?.state).toEqual({ intent: { kind: 'join', code: 'K7MQ2X' } });
    useOnboarding.getState().setIntent(null);
  });
});
