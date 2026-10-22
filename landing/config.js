// Deploy-time settings. The anon key is public by design (RLS protects data);
// invite_preview is the only call this page makes.
window.PACT_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY',
  appStoreUrl: 'https://apps.apple.com/app/idYOUR_APP_ID',
  playStoreUrl: 'https://play.google.com/store/apps/details?id=io.pactapp.pact',
};
