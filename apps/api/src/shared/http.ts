import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import type { Database } from '../db/database.js';
import type { JwtKeys, Permission, Role } from './security.js';
import { verifyAccessToken } from './security.js';
import { ApiError, badRequest, notFound, rateLimited } from './errors.js';

export interface Auth {
  userId: string;
  role: Role;
  storeId: string;
}

export interface AppContext {
  db: Database;
  keys: JwtKeys;
  enqueue: (kind: string, payload?: Record<string, unknown>) => Promise<void>;
}

export interface AuthedRequest extends Request {
  auth: Auth;
  requestId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Auth;
      requestId?: string;
      ctx?: AppContext;
    }
  }
}

export function asyncHandler<A extends Request>(
  fn: (req: A, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req as A, res, next).catch(next);
  };
}

// ---------------------------------------------------------------- responses

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  res.json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T): void {
  res.status(201).json({ data });
}

export function accepted(res: Response, data: Record<string, unknown>): void {
  res.status(202).json({ data });
}

// ---------------------------------------------------------------- validation

export function parse<T>(schema: ZodType<T>, value: unknown, label = 'body'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      `Request ${label} failed validation.`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

// ---------------------------------------------------------------- pagination

export interface Page {
  page: number;
  perPage: number;
  offset: number;
}

/** Express 5 types route params as string | string[]; routes only ever want one value. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export function parsePage(query: Record<string, unknown>, defaultPerPage = 50): Page {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const perPage = Math.min(200, Math.max(1, Number(query.per_page ?? defaultPerPage) || defaultPerPage));
  return { page, perPage, offset: (page - 1) * perPage };
}

export function pageMeta(page: Page, total: number): Record<string, unknown> {
  return {
    page: page.page,
    per_page: page.perPage,
    total,
    total_pages: Math.max(1, Math.ceil(total / page.perPage)),
  };
}

// ---------------------------------------------------------------- auth middleware

export function authenticate(ctx: AppContext): RequestHandler {
  return asyncHandler<Request>(async (req, _res, next) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthenticatedMissing();
    const claims = await verifyAccessToken(ctx.keys, header.slice(7));
    req.auth = { userId: claims.sub, role: claims.role, storeId: claims.storeId };
    next();
  });
}

function unauthenticatedMissing(): ApiError {
  return new ApiError(401, 'UNAUTHENTICATED', 'Missing bearer token.');
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (!auth) return next(unauthenticatedMissing());
    const allowed: Record<Role, boolean> = {
      OWNER: true,
      MANAGER: permission !== 'users:manage' && permission !== 'audit:read',
      CASHIER: ['catalog:read', 'stock:read', 'sales:create', 'sales:return', 'sales:read', 'reports:own'].includes(permission),
      VIEWER: ['catalog:read', 'stock:read', 'sales:read', 'purchasing:read', 'reports:all', 'ai:use'].includes(permission),
    };
    if (!allowed[auth.role]) {
      return next(new ApiError(403, 'FORBIDDEN', `Role ${auth.role} lacks permission ${permission}.`));
    }
    next();
  };
}

/**
 * Store scoping happens here, once, for every route. A caller can only act on
 * the store their token was minted for; the header may not widen it.
 */
export function resolveStore(ctx: AppContext): RequestHandler {
  return asyncHandler<Request>(async (req, _res, next) => {
    const auth = req.auth;
    if (!auth) throw unauthenticatedMissing();
    const header = req.header('x-store-id');
    if (header && header !== auth.storeId) {
      throw new ApiError(403, 'STORE_ACCESS_DENIED', 'X-Store-Id does not match the token grant.');
    }
    const rows = await ctx.db.query<{ id: string }>(
      'SELECT 1 AS id FROM role_grant WHERE user_id = $1 AND store_id = $2',
      [auth.userId, auth.storeId],
    );
    if (rows.rows.length === 0) throw new ApiError(403, 'STORE_ACCESS_DENIED', 'No grant for this store.');
    next();
  });
}

// ---------------------------------------------------------------- rate limiting

interface Bucket {
  count: number;
  resetAt: number;
}

/** In-process token bucket. Swapped for a Redis-backed limiter when scaled out. */
export function rateLimit(key: (req: Request) => string, limit: number, windowMs: number): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    const bucket = buckets.get(k);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(k, { count: 1, resetAt: now + windowMs });
      res.setHeader('RateLimit-Limit', limit);
      res.setHeader('RateLimit-Remaining', limit - 1);
      res.setHeader('RateLimit-Reset', Math.ceil((now + windowMs) / 1000));
      return next();
    }
    bucket.count++;
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, limit - bucket.count));
    res.setHeader('RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));
    if (bucket.count > limit) return next(rateLimited());
    next();
  };
}

// ---------------------------------------------------------------- error handling

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found.', request_id: _req.requestId },
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.requestId;
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, request_id: requestId },
    });
    return;
  }

  // Postgres unique violation: surface as a conflict rather than a 500.
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === '23505') {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'That record already exists.', request_id: requestId },
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ level: 'error', request_id: requestId, err: message }));
  void notFound;
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.', request_id: requestId },
  });
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = req.header('x-request-id') ?? `req_${Math.random().toString(36).slice(2, 10)}`;
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
