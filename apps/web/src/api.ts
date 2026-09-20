/** Thin API client. Every call is relative, so the browser only ever talks to one origin. */

export interface ApiError extends Error {
  code?: string;
  details?: unknown;
}

let accessToken: string | null = localStorage.getItem('ims.access');
let refreshToken: string | null = localStorage.getItem('ims.refresh');
let storeId: string | null = localStorage.getItem('ims.store');
let role: string | null = localStorage.getItem('ims.role');

export const session = {
  get token() {
    return accessToken;
  },
  get storeId() {
    return storeId;
  },
  get role() {
    return role ?? '';
  },
  clear() {
    accessToken = refreshToken = storeId = role = null;
    for (const k of ['ims.access', 'ims.refresh', 'ims.store', 'ims.role', 'ims.user']) {
      localStorage.removeItem(k);
    }
  },
};

// A 401 that cannot be refreshed means the session is over. The UI subscribes so
// it drops back to the login screen with the real reason, instead of keeping its
// authed shell and firing every later request without an Authorization header —
// which is how a user ends up staring at "Missing bearer token."
type ExpiredHandler = (reason: string) => void;
const expiredHandlers = new Set<ExpiredHandler>();

export function onSessionExpired(handler: ExpiredHandler): () => void {
  expiredHandlers.add(handler);
  return () => {
    expiredHandlers.delete(handler);
  };
}

function expireSession(reason: string): void {
  const hadSession = Boolean(accessToken);
  session.clear();
  if (!hadSession) return;
  for (const handler of expiredHandlers) handler(reason);
}

/** Endpoints that carry no access token by design: never refresh on their 401s. */
function isAuthEndpoint(path: string): boolean {
  return /^\/api(\/v1)?\/auth\/(login|refresh|logout)$/.test(path);
}

interface Rotation {
  ok: boolean;
}

let rotation: Promise<Rotation> | null = null;
let rotationFailure = '';

/**
 * Rotate the refresh token at most once per burst.
 *
 * The server treats a replayed refresh token as a leak and revokes the whole
 * family, so N parallel requests that all see a 401 must produce exactly one
 * rotation — not N. Views fetch in parallel (`Promise.all` in Stock and
 * Profit & loss) and StrictMode runs every effect twice, so this is the normal
 * case, not an edge case: without the shared promise, opening one view after
 * the 15-minute access token lapses burned the family and signed the user out.
 */
function rotate(): Promise<Rotation> {
  rotation ??= (async () => {
    const token = refreshToken;
    if (!token) return { ok: false };
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: token }),
    });
    if (!res.ok) {
      const failure = await res.json().catch(() => null);
      rotationFailure = failure?.error?.message ?? '';
      return { ok: false };
    }
    const body = await res.json();
    accessToken = body.data.access_token;
    refreshToken = body.data.refresh_token;
    localStorage.setItem('ims.access', body.data.access_token);
    localStorage.setItem('ims.refresh', body.data.refresh_token);
    rotationFailure = '';
    return { ok: true };
  })().finally(() => {
    rotation = null;
  });
  return rotation;
}

export function saveSession(data: any): void {
  accessToken = data.access_token;
  refreshToken = data.refresh_token;
  storeId = data.store.id;
  role = data.role;
  localStorage.setItem('ims.access', data.access_token);
  localStorage.setItem('ims.refresh', data.refresh_token);
  localStorage.setItem('ims.store', data.store.id);
  localStorage.setItem('ims.role', data.role);
  localStorage.setItem('ims.user', JSON.stringify(data.user));
  localStorage.setItem('ims.storeName', data.store.name);
  localStorage.setItem('ims.currency', data.store.currency);
}

export function currentUser(): any {
  try {
    return JSON.parse(localStorage.getItem('ims.user') ?? 'null');
  } catch {
    return null;
  }
}

export function storeName(): string {
  return localStorage.getItem('ims.storeName') ?? '';
}

export function currency(): string {
  return localStorage.getItem('ims.currency') ?? 'PHP';
}

async function raw(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const sentWith = accessToken;
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (storeId) headers.set('x-store-id', storeId);
  const res = await fetch(path, { ...init, headers });

  if (res.status !== 401 || isAuthEndpoint(path)) return res;

  if (!retry) {
    // Rotated once already and still rejected: this session is unusable.
    expireSession(rotationFailure || 'Your session has expired. Please sign in again.');
    return res;
  }

  // If a sibling request already rotated while this one was in flight, replay
  // with the new token instead of rotating a second time.
  const rotated = accessToken !== sentWith ? { ok: true } : await rotate();
  if (rotated.ok) return raw(path, init, false);

  expireSession(rotationFailure || 'Your session has expired. Please sign in again.');
  return res;
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await raw(path, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(body?.error?.message ?? `Request failed (${res.status})`) as ApiError;
    err.code = body?.error?.code;
    err.details = body?.error?.details;
    throw err;
  }
  return (body.data ?? body) as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown, headers?: Record<string, string>) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), headers });
export const patch = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });

/** Money is centavos on the wire; the UI is the only place it becomes pesos. */
export function money(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;
  return `${currency()} ${value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(value: number | null | undefined): string {
  return `${(value ?? 0).toFixed(1)}%`;
}
