import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
});

// "Refetch on focus" for a native app means returning to the foreground,
// where realtime sockets may have dropped while in the background.
AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
