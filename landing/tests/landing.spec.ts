import { expect, type Page, test } from '@playwright/test';

const SUPABASE = 'https://supabase.test';

async function setup(page: Page, preview: object | 'network-error') {
  const calls: { body: unknown; apikey: string | null }[] = [];
  await page.route('**/config.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.PACT_CONFIG = {
        supabaseUrl: '${SUPABASE}', supabaseAnonKey: 'anon-key',
        appStoreUrl: 'https://apps.apple.com/app/id123', playStoreUrl: 'https://play.google.com/store/apps/details?id=io.pactapp.pact'
      };`,
    }),
  );
  await page.route(`${SUPABASE}/rest/v1/rpc/invite_preview`, (route) => {
    calls.push({ body: route.request().postDataJSON(), apikey: route.request().headers()['apikey'] ?? null });
    return preview === 'network-error'
      ? route.abort()
      : route.fulfill({ contentType: 'application/json', body: JSON.stringify(preview) });
  });
  return calls;
}

const VALID = {
  status: 'valid',
  code: 'K7MQ2X',
  title: 'Walk 1 mile',
  proof_mode: 'photo',
  inviter_name: 'Alice',
  member_count: 1,
  max_members: 2,
};

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('shows the pact title, the inviter and the code in large type', async ({ page }) => {
  const calls = await setup(page, VALID);
  await page.goto('/j/K7MQ2X');

  await expect(page.locator('#invited-by')).toHaveText("Join Alice's pact");
  await expect(page.locator('#title')).toHaveText('Walk 1 mile');
  await expect(page.locator('#code')).toHaveText('K7M-Q2X');
  expect(calls).toEqual([{ body: { code: 'K7MQ2X' }, apikey: 'anon-key' }]);
});

test('copies the code to the clipboard for the app to prefill', async ({ page }) => {
  await setup(page, VALID);
  await page.goto('/j/K7MQ2X');
  await expect(page.locator('#copy-hint')).toContainText('Code copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('K7MQ2X');
});

test('store buttons link to the stores and copy the code on tap', async ({ page }) => {
  await setup(page, VALID);
  await page.goto('/j/K7MQ2X');
  await expect(page.locator('#app-store')).toHaveAttribute('href', 'https://apps.apple.com/app/id123');
  await expect(page.locator('#play-store')).toHaveAttribute('href', /id=io\.pactapp\.pact/);
  await expect(page.locator('#open-app')).toHaveAttribute('href', 'pact://j/K7MQ2X');

  await page.evaluate(() => navigator.clipboard.writeText('something else'));
  await page.route('https://apps.apple.com/**', (route) => route.fulfill({ body: 'store' }));
  await page.locator('#app-store').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('K7MQ2X');
});

test('accepts the display form and lowercase in the link', async ({ page }) => {
  const calls = await setup(page, VALID);
  await page.goto('/j/k7m-q2x');
  await expect(page.locator('#code')).toHaveText('K7M-Q2X');
  expect(calls[0].body).toEqual({ code: 'K7MQ2X' });
});

for (const [status, text] of [
  ['expired', 'This invite expired. Ask your partner to send a new one.'],
  ['full', 'This pact is already full.'],
] as const) {
  test(`explains a ${status} invite`, async ({ page }) => {
    await setup(page, { ...VALID, status });
    await page.goto('/j/K7MQ2X');
    await expect(page.locator('#status')).toHaveText(text);
  });
}

test('an unknown code reveals nothing but still offers the stores', async ({ page }) => {
  await setup(page, { status: 'invalid', code: 'K7MQ2X' });
  await page.goto('/j/K7MQ2X');
  await expect(page.locator('#status')).toContainText("doesn't exist");
  await expect(page.locator('#title')).toHaveText('One daily challenge. One shared streak.');
  await expect(page.locator('#app-store')).toBeVisible();
});

test('a malformed code never hits the network', async ({ page }) => {
  const calls = await setup(page, VALID);
  await page.goto('/j/K7M0QX');
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#code')).toBeHidden();
  expect(calls).toHaveLength(0);
});

test('still shows the code and store links when the preview call fails', async ({ page }) => {
  await setup(page, 'network-error');
  await page.goto('/j/K7MQ2X');
  await expect(page.locator('#code')).toHaveText('K7M-Q2X');
  await expect(page.locator('#play-store')).toBeVisible();
});

test('renders server text as text, never as HTML', async ({ page }) => {
  await setup(page, { ...VALID, title: '<img src=x onerror="window.pwned=1">', inviter_name: '<b>Eve</b>' });
  await page.goto('/j/K7MQ2X');
  await expect(page.locator('#title')).toHaveText('<img src=x onerror="window.pwned=1">');
  await expect(page.locator('#invited-by')).toHaveText("Join <b>Eve</b>'s pact");
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test('fits a phone screen without horizontal scroll', async ({ page }) => {
  await setup(page, { ...VALID, title: 'W'.repeat(40) });
  await page.goto('/j/K7MQ2X');
  await expect(page.locator('#title')).toHaveText('W'.repeat(40));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('serves the app-link association files', async ({ request }) => {
  const aasa = await request.get('/.well-known/apple-app-site-association');
  expect(aasa.headers()['content-type']).toContain('application/json');
  const details = (await aasa.json()).applinks.details[0];
  expect(details.appIDs[0]).toMatch(/\.io\.pactapp\.pact$/);
  expect(details.components).toContainEqual(expect.objectContaining({ '/': '/j/*' }));

  const assetlinks = await (await request.get('/.well-known/assetlinks.json')).json();
  expect(assetlinks[0].target.package_name).toBe('io.pactapp.pact');
});
