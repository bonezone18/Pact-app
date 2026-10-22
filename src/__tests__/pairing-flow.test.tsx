import * as Clipboard from 'expo-clipboard';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Share } from 'react-native';

import { queryClient } from '@/lib/query-client';
import { useOnboarding } from '@/stores/onboarding';
import { fake } from '@/test/fake-supabase';

jest.mock('@/lib/supabase', () => ({ supabase: require('@/test/fake-supabase').fake.client }));
jest.mock('@/lib/timezone', () => ({ syncTimezone: jest.fn(async () => undefined) }));
jest.mock('@/lib/auth', () => {
  const { fake: f } = require('@/test/fake-supabase');
  class SignInCancelled extends Error {}
  return {
    SignInCancelled,
    signInWithApple: jest.fn(),
    signInWithGoogle: jest.fn(async () => f.controls.signIn()),
    signOut: jest.fn(async () => f.controls.setSession(null)),
  };
});
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: jest.fn(async () => false),
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: {},
  AppleAuthenticationButtonStyle: {},
  AppleAuthenticationScope: {},
}));

const { client, controls } = fake;
const APP = 'src/app';
const FUTURE = '2099-01-01T00:00:00Z';

type RpcHandlers = Record<string, { data?: unknown; error?: { message: string } }>;
function rpcReturns(handlers: RpcHandlers) {
  client.rpc.mockImplementation(async (fn: string) => ({
    data: handlers[fn]?.data ?? null,
    error: handlers[fn]?.error ?? null,
  }));
}

const VALID_PREVIEW = {
  status: 'valid',
  code: 'K7MQ2X',
  title: 'Walk 1 mile',
  proof_mode: 'photo',
  inviter_name: 'Alice',
  member_count: 1,
  max_members: 2,
  expires_at: FUTURE,
};

let shareSpy: jest.SpyInstance;

beforeEach(() => {
  controls.reset();
  queryClient.clear();
  useOnboarding.setState({ intent: null });
  jest.mocked(Clipboard.hasStringAsync).mockResolvedValue(false);
  jest.mocked(Clipboard.getStringAsync).mockResolvedValue('');
  shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
  controls.setTable('pacts', []);
});

afterEach(() => shareSpy.mockRestore());

describe('first launch', () => {
  it('sends a signed-out user to the welcome screen', async () => {
    const app = await renderRouter(APP, { initialUrl: '/' });
    await waitFor(() => expect(app.getPathname()).toBe('/welcome'));
    expect(screen.getByText('Got an invite code?')).toBeTruthy();
  });

  it('prefills the invite code from the clipboard when it matches the format', async () => {
    jest.mocked(Clipboard.hasStringAsync).mockResolvedValue(true);
    jest.mocked(Clipboard.getStringAsync).mockResolvedValue('https://lockstep.app/j/K7MQ2X');
    const app = await renderRouter(APP, { initialUrl: '/welcome' });

    await waitFor(() => expect(screen.getByLabelText('Invite code').props.value).toBe('K7M-Q2X'));
    await fireEvent.press(screen.getByRole('button', { name: 'Join with code' }));

    await waitFor(() => expect(app.getPathname()).toBe('/sign-in'));
    expect(useOnboarding.getState().intent).toEqual({ kind: 'join', code: 'K7MQ2X' });
  });

  it('ignores clipboard text that is not an invite code', async () => {
    jest.mocked(Clipboard.hasStringAsync).mockResolvedValue(true);
    jest.mocked(Clipboard.getStringAsync).mockResolvedValue('see you at 5');
    await renderRouter(APP, { initialUrl: '/welcome' });

    await waitFor(() => expect(Clipboard.getStringAsync).toHaveBeenCalled());
    expect(screen.getByLabelText('Invite code').props.value).toBe('');
    expect(screen.getByRole('button', { name: 'Join with code' })).toBeDisabled();
  });
});

describe('invitee path', () => {
  it('invite link -> preview -> sign in -> join -> dashboard', async () => {
    rpcReturns({ invite_preview: { data: VALID_PREVIEW }, join_pact: { data: { pact_id: 'p1', status: 'active' } } });
    const app = await renderRouter(APP, { initialUrl: '/j/K7MQ2X' });

    await waitFor(() => expect(app.getPathname()).toBe('/join/K7MQ2X'));
    await waitFor(() => expect(screen.getByText("Join Alice's streak")).toBeTruthy());
    expect(screen.getByText('Walk 1 mile')).toBeTruthy();
    expect(client.rpc).toHaveBeenCalledWith('invite_preview', { code: 'K7MQ2X' });

    await fireEvent.press(screen.getByRole('button', { name: 'Sign in to join' }));
    await waitFor(() => expect(app.getPathname()).toBe('/sign-in'));

    await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(app.getPathname()).toBe('/join/K7MQ2X'));

    await fireEvent.press(await screen.findByRole('button', { name: 'Join streak' }));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    expect(client.rpc).toHaveBeenCalledWith('join_pact', { code: 'K7MQ2X' });
    expect(useOnboarding.getState().intent).toBeNull();
  });

  it.each([
    ['expired', 'This invite expired. Ask your partner to send a new one.'],
    ['full', 'This streak is already full.'],
    ['invalid', "This invite doesn't exist or was replaced. Ask for a fresh link."],
  ])('explains a %s invite instead of offering to join', async (status, message) => {
    rpcReturns({ invite_preview: { data: { ...VALID_PREVIEW, status } } });
    await renderRouter(APP, { initialUrl: '/join/K7MQ2X' });
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
  });

  it('sends a free user who is already in a pact to the paywall', async () => {
    controls.signIn();
    rpcReturns({ invite_preview: { data: VALID_PREVIEW }, join_pact: { error: { message: 'pro_required' } } });
    const app = await renderRouter(APP, { initialUrl: '/join/K7MQ2X' });

    await fireEvent.press(await screen.findByRole('button', { name: 'Join streak' }));
    await waitFor(() => expect(app.getPathname()).toBe('/paywall'));
  });

  it('shows the server error for a code that failed at join time', async () => {
    controls.signIn();
    rpcReturns({ invite_preview: { data: VALID_PREVIEW }, join_pact: { error: { message: 'pact_full' } } });
    await renderRouter(APP, { initialUrl: '/join/K7MQ2X' });

    await fireEvent.press(await screen.findByRole('button', { name: 'Join streak' }));
    expect(await screen.findByText('That streak is already full.')).toBeTruthy();
  });
});

describe('creator path', () => {
  it('start -> sign in -> create -> share sheet over the waiting room -> partner joins -> dashboard', async () => {
    rpcReturns({ create_pact: { data: { pact_id: 'p1', code: 'K7MQ2X', expires_at: FUTURE } } });
    const app = await renderRouter(APP, { initialUrl: '/welcome' });

    await fireEvent.press(await screen.findByRole('button', { name: 'Start a streak' }));
    await waitFor(() => expect(app.getPathname()).toBe('/sign-in'));
    await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(app.getPathname()).toBe('/create'));

    controls.setTable('pacts', { id: 'p1', title: 'Walk 1 mile', status: 'pending' });
    controls.setTable('pact_invites', { code: 'K7MQ2X', expires_at: FUTURE });

    await fireEvent.press(screen.getByRole('button', { name: 'Walk 1 mile' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Tap' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create and invite' }));

    await waitFor(() => expect(app.getPathname()).toBe('/invite/p1'));
    expect(client.rpc).toHaveBeenCalledWith('create_pact', { title: 'Walk 1 mile', proof_mode: 'tap', max_members: 2 });
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(shareSpy.mock.calls[0][0].message).toContain('https://lockstep.app/j/K7MQ2X');
    expect(await screen.findByText('K7M-Q2X')).toBeTruthy();

    // Partner joins: realtime flips the pact to active.
    controls.setTable('pacts', []);
    await act(async () => controls.emit('pacts', { id: 'p1', status: 'active' }));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
  });

  it('sends a free user over the limit to the paywall', async () => {
    controls.signIn();
    rpcReturns({ create_pact: { error: { message: 'pro_required' } } });
    const app = await renderRouter(APP, { initialUrl: '/create' });

    await fireEvent.changeText(await screen.findByLabelText('Streak title'), 'Gym');
    await fireEvent.press(screen.getByRole('button', { name: 'Create and invite' }));
    await waitFor(() => expect(app.getPathname()).toBe('/paywall'));
    expect(shareSpy).not.toHaveBeenCalled();
  });

  it('only offers pod sizes to Pro users', async () => {
    controls.signIn();
    controls.setTable('entitlements', { is_pro: false, expires_at: null });
    await renderRouter(APP, { initialUrl: '/create' });
    await screen.findByLabelText('Streak title');
    expect(screen.queryByText('Members')).toBeNull();
  });

  it('pod sizes appear for Pro users and reach create_pact', async () => {
    controls.signIn();
    controls.setTable('entitlements', { is_pro: true, expires_at: null });
    rpcReturns({ create_pact: { data: { pact_id: 'p2', code: 'K7MQ2X', expires_at: FUTURE } } });
    const app = await renderRouter(APP, { initialUrl: '/create' });

    await fireEvent.press(await screen.findByRole('button', { name: '3' }));
    await fireEvent.changeText(screen.getByLabelText('Streak title'), 'Gym');
    await fireEvent.press(screen.getByRole('button', { name: 'Create and invite' }));
    await waitFor(() => expect(app.getPathname()).toBe('/invite/p2'));
    expect(client.rpc).toHaveBeenCalledWith('create_pact', { title: 'Gym', proof_mode: 'photo', max_members: 3 });
  });
});

describe('waiting room', () => {
  beforeEach(() => controls.signIn());

  it('goes straight to the dashboard if the partner joined while away', async () => {
    controls.setTable('pacts', { id: 'p1', title: 'Gym', status: 'active' });
    const app = await renderRouter(APP, { initialUrl: '/invite/p1' });
    await waitFor(() => expect(app.getPathname()).toBe('/'));
  });

  it('regenerates an expired code', async () => {
    controls.setTable('pacts', { id: 'p1', title: 'Gym', status: 'pending' });
    controls.setTable('pact_invites', { code: 'K7MQ2X', expires_at: '2000-01-01T00:00:00Z' });
    rpcReturns({ regenerate_invite: { data: { code: 'ABCDEF' } } });
    await renderRouter(APP, { initialUrl: '/invite/p1' });

    expect(await screen.findByText(/This invite has expired/)).toBeTruthy();
    controls.setTable('pact_invites', { code: 'ABCDEF', expires_at: FUTURE });
    await fireEvent.press(screen.getByRole('button', { name: 'New code' }));
    expect(await screen.findByText('ABC-DEF')).toBeTruthy();
    expect(client.rpc).toHaveBeenCalledWith('regenerate_invite', { pact_id: 'p1' });
  });

  it('subscribes to this pact only, and cleans up', async () => {
    controls.setTable('pacts', { id: 'p1', title: 'Gym', status: 'pending' });
    controls.setTable('pact_invites', { code: 'K7MQ2X', expires_at: FUTURE });
    const app = await renderRouter(APP, { initialUrl: '/invite/p1' });
    await screen.findByText('K7M-Q2X');
    expect(client.channel).toHaveBeenCalledWith('waiting-room:p1');
    await app.unmount();
    expect(client.removeChannel).toHaveBeenCalled();
  });
});
