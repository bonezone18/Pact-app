import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { queryClient } from '@/lib/query-client';
import { supabase } from '@/lib/supabase';

// Pushes that arrive while the app is open still show (they're the game), but quietly.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let currentToken: string | null = null;

/**
 * Registers this device's Expo push token for the signed-in user.
 * On launch we only register if permission was already granted; the system
 * prompt is shown once the user has a pact to be notified about.
 */
export async function registerForPush({ prompt }: { prompt: boolean }): Promise<string | null> {
  if (!Device.isDevice) return null; // simulators have no push token
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Streak updates',
      importance: AndroidImportance.HIGH,
    });
  }

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted' && prompt) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) {
    console.warn('Push disabled: no EAS projectId. Run `npx eas-cli@latest init`.');
    return null;
  }
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  const { error } = await supabase.rpc('register_push_token', {
    token,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
  });
  if (error) return null;
  currentToken = token;
  return token;
}

/** Called before signing out, so this device stops getting that account's pushes. */
export async function unregisterPush(): Promise<void> {
  if (!currentToken) return;
  await supabase.from('push_tokens').delete().eq('token', currentToken);
  currentToken = null;
}

/** Only our own screens: a push can never send the app somewhere arbitrary. */
const ALLOWED = /^\/(?:$|check-in\/[\w-]+$|pact\/[\w-]+$|invite\/[\w-]+$|join\/[A-Za-z0-9-]+$)/;
export function pushTarget(data: unknown): string | null {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && ALLOWED.test(url) ? url : null;
}

const handled = new Set<string>();

function open(response: Notifications.NotificationResponse) {
  const id = response.notification.request.identifier;
  if (handled.has(id)) return;
  handled.add(id);
  const url = pushTarget(response.notification.request.content.data);
  if (url) router.push(url as never);
}

/**
 * While signed in: register the device, open the right screen when a push is
 * tapped (including the one that launched the app), and refresh today's
 * state when a push arrives in the foreground.
 */
export function usePushNotifications(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return;
    registerForPush({ prompt: false }).catch(() => undefined);

    const launch = Notifications.getLastNotificationResponse();
    if (launch) open(launch);

    const tapped = Notifications.addNotificationResponseReceivedListener(open);
    const received = Notifications.addNotificationReceivedListener(() => {
      queryClient.invalidateQueries({ queryKey: ['pact-today'] });
    });
    return () => {
      tapped.remove();
      received.remove();
    };
  }, [signedIn]);
}
