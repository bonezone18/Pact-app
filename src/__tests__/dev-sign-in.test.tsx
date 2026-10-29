import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { queryClient } from '@/lib/query-client';
import { fake } from '@/test/fake-supabase';

jest.mock('@/lib/supabase', () => ({ supabase: require('@/test/fake-supabase').fake.client }));
jest.mock('@/lib/timezone', () => ({
  syncTimezone: jest.fn(async () => undefined),
  deviceTimezone: () => 'Europe/London',
}));
const mockEnabled = jest.fn(() => true);
jest.mock('@/lib/dev-auth', () => ({ ...jest.requireActual('@/lib/dev-auth'), devSignInEnabled: () => mockEnabled() }));

const { client, controls } = fake;

beforeEach(() => {
  controls.reset();
  queryClient.clear();
  mockEnabled.mockReturnValue(true);
  controls.setTable('pacts', []);
});

it('is hidden unless enabled for development', async () => {
  mockEnabled.mockReturnValue(false);
  await renderRouter('src/app', { initialUrl: '/sign-in' });
  expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  expect(screen.queryByLabelText('Email')).toBeNull();
});

it('creates the account on first use, with a name and timezone for the profile', async () => {
  client.auth.signUp.mockImplementation(async () => {
    controls.signIn('new-user');
    return { data: { session: { user: { id: 'new-user' } } }, error: null };
  });
  const app = await renderRouter('src/app', { initialUrl: '/sign-in' });

  await fireEvent.changeText(await screen.findByLabelText('Email'), 'alice.smith@test.dev');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'secret1');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in with email' }));

  await waitFor(() => expect(app.getPathname()).toBe('/'));
  expect(client.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'alice.smith@test.dev', password: 'secret1' });
  expect(client.auth.signUp).toHaveBeenCalledWith({
    email: 'alice.smith@test.dev',
    password: 'secret1',
    options: { data: { full_name: 'Alice Smith', timezone: 'Europe/London' } },
  });
});

it('signs straight in when the account exists', async () => {
  client.auth.signInWithPassword.mockImplementation(async () => {
    controls.signIn('alice');
    return { data: { session: { user: { id: 'alice' } } }, error: null };
  });
  const app = await renderRouter('src/app', { initialUrl: '/sign-in' });
  await fireEvent.changeText(await screen.findByLabelText('Email'), 'alice@test.dev');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'secret1');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in with email' }));
  await waitFor(() => expect(app.getPathname()).toBe('/'));
  expect(client.auth.signUp).not.toHaveBeenCalled();
});

it('explains when the project still requires email confirmation', async () => {
  await renderRouter('src/app', { initialUrl: '/sign-in' });
  await fireEvent.changeText(await screen.findByLabelText('Email'), 'bob@test.dev');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'secret1');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in with email' }));
  expect(await screen.findByText(/requires email confirmation/)).toBeTruthy();
});
