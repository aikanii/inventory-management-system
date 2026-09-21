/**
 * Session handling in the API client.
 *
 * Every test here is a bug that reached a user: a burst of parallel requests
 * burning the refresh-token family, a failed login rotating a live token, and a
 * dead session's last failure signing out the session the user had just
 * replaced it with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const error401 = (code: string, message: string) => json(401, { error: { code, message } });

interface Route {
  match: (url: string) => boolean;
  respond: (init: any) => Response | Promise<Response>;
}

/** Script the network: the first route whose `match` wins, in order. */
function stubNetwork(routes: Route[]): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: any, init: any = {}) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    const route = routes.find((r) => r.match(String(url)));
    if (!route) throw new Error(`unexpected fetch: ${String(url)}`);
    return route.respond(init);
  });
  return calls;
}

const bearerOf = (init: any) => new Headers(init?.headers).get('authorization');

/** 401 for a lapsed token, 200 for a current one — what the server really does. */
const dataIfCurrent = (valid: string[], body: unknown) => (init: any) => (valid.includes(bearerOf(init) ?? '')
  ? json(200, { data: body })
  : error401('TOKEN_INVALID', 'Access token expired.'));

/** A fresh module instance, the way a page load re-reads localStorage. */
async function loadClient() {
  vi.resetModules();
  return import('../src/api.ts');
}

function signedIn(access = 'access-1', refresh = 'refresh-1') {
  store.clear();
  store.set('ims.access', access);
  store.set('ims.refresh', refresh);
  store.set('ims.store', 'store-1');
  store.set('ims.role', 'OWNER');
}

const rotated = (n: number) =>
  json(200, { data: { access_token: `access-${n}`, refresh_token: `refresh-${n}` } });

beforeEach(() => {
  store.clear();
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

describe('token rotation', () => {
  it('rotates once when a parallel burst all see a 401', async () => {
    signedIn('expired', 'refresh-1');
    const calls = stubNetwork([
      { match: (u) => u.includes('/auth/refresh'), respond: () => rotated(2) },
      { match: () => true, respond: dataIfCurrent(['Bearer access-2'], { rows: [] }) },
    ]);
    const api = await loadClient();

    // What Stock and Profit & loss actually do: several requests at once.
    const results = await Promise.allSettled([
      api.get('/api/v1/reports/profit-loss'),
      api.get('/api/v1/reports/product-performance'),
      api.get('/api/v1/reports/inventory-ageing'),
    ]);

    expect(calls.filter((c) => c.includes('/auth/refresh'))).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(calls.filter((c) => c.startsWith('GET /api/v1/reports/'))).toHaveLength(6); // 3 + 3 replays
    expect(store.get('ims.refresh')).toBe('refresh-2');
  });

  it('ends the session with the server reason when the refresh is refused', async () => {
    signedIn('expired', 'revoked');
    stubNetwork([
      {
        match: (u) => u.includes('/auth/refresh'),
        respond: () => error401('REFRESH_TOKEN_REUSED', 'Refresh token reuse detected; re-authentication required.'),
      },
      { match: () => true, respond: dataIfCurrent([], { rows: [] }) },
    ]);
    const api = await loadClient();
    const reasons: string[] = [];
    api.onSessionExpired((reason: string) => reasons.push(reason));

    await expect(api.get('/api/v1/reports/dashboard')).rejects.toThrow('Access token expired.');
    expect(reasons).toEqual(['Refresh token reuse detected; re-authentication required.']);
    expect(store.get('ims.access')).toBeUndefined();
  });

  it('does not rotate the refresh token when a login fails', async () => {
    signedIn('access-1', 'refresh-1');
    const calls = stubNetwork([
      { match: (u) => u.includes('/auth/refresh'), respond: () => rotated(2) },
      { match: () => true, respond: () => error401('UNAUTHENTICATED', 'Invalid email or password.') },
    ]);
    const api = await loadClient();
    const reasons: string[] = [];
    api.onSessionExpired((reason: string) => reasons.push(reason));

    await expect(api.post('/api/v1/auth/login', { email: 'x', password: 'y' }))
      .rejects.toThrow('Invalid email or password.');

    expect(calls.some((c) => c.includes('/auth/refresh'))).toBe(false);
    expect(reasons).toEqual([]);
    expect(store.get('ims.refresh')).toBe('refresh-1');
  });
});

describe('a session that has been replaced', () => {
  it("does not let a dead session's failure sign out the one the user just started", async () => {
    // Storage holds a session from a previous server boot: its access token no
    // longer verifies and its refresh token is unknown.
    signedIn('stale-access', 'stale-refresh');
    let releaseRefresh: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    const calls = stubNetwork([
      {
        match: (u) => u.includes('/auth/refresh'),
        respond: async () => {
          await gate; // a slow network: the failure lands after the sign-in
          return error401('UNAUTHENTICATED', 'Unknown refresh token.');
        },
      },
      {
        match: (u) => u.includes('/auth/login'),
        respond: () => json(200, {
          data: {
            access_token: 'fresh-access', refresh_token: 'fresh-refresh', role: 'OWNER',
            store: { id: 'store-1', name: 'Demo', currency: 'PHP' }, user: { full_name: 'Owner' },
          },
        }),
      },
      { match: () => true, respond: dataIfCurrent(['Bearer fresh-access'], { ok: true }) },
    ]);

    const api = await loadClient();
    const reasons: string[] = [];
    api.onSessionExpired((reason: string) => reasons.push(reason));

    const inFlight = api.get('/api/v1/reports/dashboard');
    api.saveSession(await api.post('/api/v1/auth/login', { email: 'owner@demo.ims', password: 'pw' }));
    releaseRefresh();

    await expect(inFlight).resolves.toEqual({ ok: true });
    expect(reasons).toEqual([]);
    expect(store.get('ims.access')).toBe('fresh-access');
    expect(store.get('ims.refresh')).toBe('fresh-refresh');
    expect(calls.filter((c) => c.includes('/auth/refresh'))).toHaveLength(1);
  });

  it('still ends the session when the token that replaced it is rejected too', async () => {
    signedIn('stale-access', 'stale-refresh');
    let releaseRefresh: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    stubNetwork([
      {
        match: (u) => u.includes('/auth/refresh'),
        respond: async () => {
          await gate;
          return error401('UNAUTHENTICATED', 'Unknown refresh token.');
        },
      },
      {
        match: (u) => u.includes('/auth/login'),
        respond: () => json(200, {
          data: {
            access_token: 'fresh-access', refresh_token: 'fresh-refresh', role: 'OWNER',
            store: { id: 'store-1', name: 'Demo', currency: 'PHP' }, user: { full_name: 'Owner' },
          },
        }),
      },
      { match: () => true, respond: dataIfCurrent([], { ok: true }) }, // the server refuses everything
    ]);

    const api = await loadClient();
    const reasons: string[] = [];
    api.onSessionExpired((reason: string) => reasons.push(reason));

    const inFlight = api.get('/api/v1/reports/dashboard');
    api.saveSession(await api.post('/api/v1/auth/login', { email: 'owner@demo.ims', password: 'pw' }));
    releaseRefresh();

    await expect(inFlight).rejects.toThrow();
    expect(reasons).toEqual(['Unknown refresh token.']);
    expect(store.get('ims.access')).toBeUndefined();
  });

  it('replays a request against the new token when a sign-in lands mid-flight', async () => {
    signedIn('stale-access', 'stale-refresh');
    let releaseRefresh: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let served = 0;

    stubNetwork([
      {
        match: (u) => u.includes('/auth/refresh'),
        respond: async () => {
          await gate;
          return error401('UNAUTHENTICATED', 'Unknown refresh token.');
        },
      },
      {
        match: (u) => u.includes('/auth/login'),
        respond: () => json(200, {
          data: {
            access_token: 'fresh-access', refresh_token: 'fresh-refresh', role: 'OWNER',
            store: { id: 'store-1', name: 'Demo', currency: 'PHP' }, user: { full_name: 'Owner' },
          },
        }),
      },
      {
        match: () => true,
        respond: () => (++served === 1
          ? error401('TOKEN_INVALID', 'Access token is invalid.')
          : json(200, { data: { ok: true } })),
      },
    ]);

    const api = await loadClient();
    const inFlight = api.get('/api/v1/reports/dashboard');
    api.saveSession(await api.post('/api/v1/auth/login', { email: 'owner@demo.ims', password: 'pw' }));
    releaseRefresh();

    await expect(inFlight).resolves.toEqual({ ok: true });
  });
});
