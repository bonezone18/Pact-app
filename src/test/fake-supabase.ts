// A tiny stand-in for the Supabase client used by the screen tests: auth with
// a controllable session, rpc() as a jest mock, table reads from fixtures and
// realtime channels whose callbacks the test can fire.

type Result = { data: unknown; error: { message: string } | null };
type Listener = (event: string, session: unknown) => void;
type ChannelHandler = (payload: { new: Record<string, unknown> }) => void;

type AuthResult = { data: { session: unknown }; error: { message: string } | null };
const noAccount = async (_creds: { email: string; password: string }): Promise<AuthResult> => ({
  data: { session: null },
  error: { message: 'Invalid login credentials' },
});
const noSession = async (_args: { email: string; password: string; options?: unknown }): Promise<AuthResult> => ({
  data: { session: null },
  error: null,
});

export function createFakeSupabase() {
  let session: unknown = null;
  const listeners = new Set<Listener>();
  const tables: Record<string, Result> = {};
  const channelHandlers: { filter: unknown; handler: ChannelHandler }[] = [];

  const query = (table: string) => {
    const result = () => Promise.resolve(tables[table] ?? { data: [], error: null });
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'is', 'order', 'limit', 'update', 'delete', 'in']) {
      builder[m] = () => builder;
    }
    builder.single = result;
    builder.maybeSingle = result;
    builder.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      result().then(resolve, reject);
    return builder;
  };

  const storageApi = {
    upload: jest.fn(async (_path: string, _body: unknown, _opts?: unknown) => ({ data: {} as unknown, error: null as unknown })),
    remove: jest.fn(async (_paths: string[]) => ({ data: [], error: null })),
    createSignedUrls: jest.fn(async (paths: string[], _expires: number) => ({
      data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${path}`, error: null })),
      error: null,
    })),
  };

  const client = {
    storage: { from: jest.fn((_bucket: string) => storageApi) },
    auth: {
      getSession: jest.fn(async () => ({ data: { session } })),
      onAuthStateChange: jest.fn((listener: Listener) => {
        listeners.add(listener);
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
      }),
      signOut: jest.fn(async () => controls.setSession(null)),
      signInWithPassword: jest.fn(noAccount),
      signUp: jest.fn(noSession),
      startAutoRefresh: jest.fn(),
      stopAutoRefresh: jest.fn(),
    },
    rpc: jest.fn(async (_fn: string, _args?: unknown): Promise<Result> => ({ data: null, error: null })),
    from: jest.fn(query),
    channel: jest.fn(() => {
      const channel = {
        on: (_type: string, filter: unknown, handler: ChannelHandler) => {
          channelHandlers.push({ filter, handler });
          return channel;
        },
        subscribe: () => channel,
      };
      return channel;
    }),
    removeChannel: jest.fn(),
  };

  const controls = {
    setSession(next: unknown) {
      session = next;
      listeners.forEach((l) => l(next ? 'SIGNED_IN' : 'SIGNED_OUT', next));
    },
    signIn(userId = 'user-1') {
      controls.setSession({ user: { id: userId }, access_token: 'token' });
    },
    setTable(table: string, data: unknown, error: Result['error'] = null) {
      tables[table] = { data, error };
    },
    /** Fire every realtime handler registered for this table. */
    emit(table: string, row: Record<string, unknown>) {
      channelHandlers
        .filter((c) => (c.filter as { table?: string }).table === table)
        .forEach((c) => c.handler({ new: row }));
    },
    reset() {
      session = null;
      listeners.clear();
      channelHandlers.length = 0;
      for (const k of Object.keys(tables)) delete tables[k];
      client.rpc.mockReset();
      client.rpc.mockImplementation(async () => ({ data: null, error: null }));
      client.auth.signInWithPassword.mockReset();
      client.auth.signInWithPassword.mockImplementation(noAccount);
      client.auth.signUp.mockReset();
      client.auth.signUp.mockImplementation(noSession);
      storageApi.upload.mockReset();
      storageApi.upload.mockImplementation(async () => ({ data: {}, error: null }));
      storageApi.remove.mockClear();
      storageApi.createSignedUrls.mockClear();
    },
  };

  return { client, controls, storageApi };
}

/** Shared instance for jest.mock('@/lib/supabase', ...). */
export const fake = createFakeSupabase();
