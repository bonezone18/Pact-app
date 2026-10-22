import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { act, renderRouter, waitFor } from 'expo-router/testing-library';

import { queryClient } from '@/lib/query-client';
import { fake } from '@/test/fake-supabase';

jest.mock('@/lib/supabase', () => ({ supabase: require('@/test/fake-supabase').fake.client }));
jest.mock('@/lib/timezone', () => ({ syncTimezone: jest.fn(async () => undefined) }));
jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'proj-123' } } } } }));

const push = require('@/lib/push') as typeof import('@/lib/push');
const { client, controls } = fake;
const N = jest.mocked(Notifications);

function response(id: string, url: unknown): Notifications.NotificationResponse {
  return {
    actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
    notification: { request: { identifier: id, content: { data: { url } } } },
  } as unknown as Notifications.NotificationResponse;
}

beforeEach(() => {
  controls.reset();
  queryClient.clear();
  jest.clearAllMocks();
  N.getPermissionsAsync.mockResolvedValue({ status: 'granted' } as never);
  N.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[device-1]' });
  N.getLastNotificationResponse.mockReturnValue(null);
});

describe('registering the device', () => {
  it('registers the Expo token for the signed-in user when permission is granted', async () => {
    expect(await push.registerForPush({ prompt: false })).toBe('ExponentPushToken[device-1]');
    expect(N.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-123' });
    expect(client.rpc).toHaveBeenCalledWith('register_push_token', { token: 'ExponentPushToken[device-1]', platform: 'ios' });
  });

  it('never shows the system prompt on launch', async () => {
    N.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' } as never);
    expect(await push.registerForPush({ prompt: false })).toBeNull();
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('asks once there is a pact, and registers if allowed', async () => {
    N.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' } as never);
    N.requestPermissionsAsync.mockResolvedValue({ status: 'granted' } as never);
    expect(await push.registerForPush({ prompt: true })).toBe('ExponentPushToken[device-1]');
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('respects a refusal', async () => {
    N.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' } as never);
    N.requestPermissionsAsync.mockResolvedValue({ status: 'denied' } as never);
    expect(await push.registerForPush({ prompt: true })).toBeNull();
    expect(N.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('signing out removes this device from the account', async () => {
    await push.registerForPush({ prompt: false });
    await push.unregisterPush();
    expect(client.from).toHaveBeenCalledWith('push_tokens');
  });
});

describe('where a tapped push may go', () => {
  it.each(['/', '/check-in/2f1c-ab', '/pact/p1', '/invite/p1', '/join/K7MQ2X'])('%s is allowed', (url) => {
    expect(push.pushTarget({ url })).toBe(url);
  });

  it.each([
    'https://evil.example/phish',
    '//evil.example',
    'lockstep://check-in/p1',
    '/check-in/p1/../../settings',
    '/settings',
    '',
    42,
    null,
  ])('%p is refused', (url) => {
    expect(push.pushTarget({ url })).toBeNull();
  });

  it('handles missing data', () => {
    expect(push.pushTarget(null)).toBeNull();
    expect(push.pushTarget(undefined)).toBeNull();
  });
});

describe('opening the app from a push', () => {
  beforeEach(() => {
    controls.signIn('user-1');
    controls.setTable('pacts', []);
  });

  it('a push that launched the app opens its screen (cold start)', async () => {
    N.getLastNotificationResponse.mockReturnValue(response('cold-1', '/invite/p9'));
    controls.setTable('pacts', { id: 'p9', title: 'Gym', status: 'pending' });
    const app = await renderRouter('src/app', { initialUrl: '/' });
    await waitFor(() => expect(app.getPathname()).toBe('/invite/p9'));
  });

  it('a push tapped while the app is running opens its screen, once', async () => {
    const app = await renderRouter('src/app', { initialUrl: '/' });
    await waitFor(() => expect(N.addNotificationResponseReceivedListener).toHaveBeenCalled());
    const onTap = N.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];

    await act(async () => onTap(response('tap-1', '/join/K7MQ2X')));
    await waitFor(() => expect(app.getPathname()).toBe('/join/K7MQ2X'));

    // The same response delivered again (e.g. listener + launch) is ignored.
    await act(async () => router.replace('/'));
    await act(async () => onTap(response('tap-1', '/join/K7MQ2X')));
    expect(app.getPathname()).toBe('/');
  });

  it('ignores a push pointing outside the app', async () => {
    const app = await renderRouter('src/app', { initialUrl: '/' });
    await waitFor(() => expect(N.addNotificationResponseReceivedListener).toHaveBeenCalled());
    const onTap = N.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];
    await act(async () => onTap(response('tap-2', 'https://evil.example')));
    expect(app.getPathname()).toBe('/');
  });

  it('a push arriving in the foreground refreshes today', async () => {
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    await renderRouter('src/app', { initialUrl: '/' });
    await waitFor(() => expect(N.addNotificationReceivedListener).toHaveBeenCalled());
    const onReceive = N.addNotificationReceivedListener.mock.calls.at(-1)![0];
    await act(async () => onReceive({} as Notifications.Notification));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['pact-today'] });
  });

  it('registers the device on launch when signed in', async () => {
    await renderRouter('src/app', { initialUrl: '/' });
    await waitFor(() =>
      expect(client.rpc).toHaveBeenCalledWith('register_push_token', { token: 'ExponentPushToken[device-1]', platform: 'ios' }),
    );
  });

  it('does nothing while signed out', async () => {
    controls.setSession(null);
    await renderRouter('src/app', { initialUrl: '/' });
    expect(N.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith('register_push_token', expect.anything());
  });
});
