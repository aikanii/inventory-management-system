import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppContext, AuthedRequest } from '../shared/http.js';
import { authenticate, asyncHandler, created, ok, parse, rateLimit } from '../shared/http.js';
import {
  REFRESH_TOKEN_TTL_DAYS, ACCESS_TOKEN_TTL_SECONDS, audit, hashPassword, newRefreshToken,
  rotateRefreshToken, signAccessToken, verifyPassword, type Role,
} from '../shared/security.js';
import { unauthenticated } from '../shared/errors.js';

const credentials = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
  store_id: z.string().optional(),
});

const newUser = z.object({
  email: z.string().min(3),
  password: z.string().min(10),
  full_name: z.string().min(1),
  role: z.enum(['OWNER', 'MANAGER', 'CASHIER', 'VIEWER']),
});

export function authRouter(ctx: AppContext): Router {
  const r = Router();

  r.post(
    '/login',
    rateLimit((req) => `${req.ip}:${String(req.body?.email ?? '')}`, 5, 60_000),
    asyncHandler(async (req, res) => {
      const body = parse(credentials, req.body);
      const users = await ctx.db.query<{
        id: string; email: string; password_hash: string; full_name: string; is_active: boolean;
      }>('SELECT id, email, password_hash, full_name, is_active FROM app_user WHERE lower(email) = lower($1)', [body.email]);
      const user = users.rows[0];

      // Identical response for unknown account and wrong password: no enumeration.
      if (!user || !user.is_active || !(await verifyPassword(user.password_hash, body.password))) {
        throw unauthenticated('UNAUTHENTICATED', 'Invalid email or password.');
      }

      const grants = await ctx.db.query<{ store_id: string; role: Role; code: string; name: string; timezone: string; currency: string }>(
        `SELECT g.store_id, g.role, s.code, s.name, s.timezone, s.currency
           FROM role_grant g JOIN store s ON s.id = g.store_id
          WHERE g.user_id = $1 ORDER BY g.created_at`,
        [user.id],
      );
      if (grants.rows.length === 0) throw unauthenticated('STORE_ACCESS_DENIED', 'This account has no store grant.');

      const grant = body.store_id ? grants.rows.find((g) => g.store_id === body.store_id) : grants.rows[0];
      if (!grant) throw unauthenticated('STORE_ACCESS_DENIED', 'No grant for the requested store.');

      const token = newRefreshToken();
      const familyId = randomUUID();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);
      await ctx.db.query(
        'INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
        [user.id, familyId, token.hash, expiresAt],
      );

      const accessToken = await signAccessToken(ctx.keys, {
        sub: user.id, role: grant.role, storeId: grant.store_id,
      });
      await audit(ctx.db, {
        storeId: grant.store_id, actorId: user.id, action: 'auth.login', entity: 'app_user', entityId: user.id,
      });

      ok(res, {
        access_token: accessToken,
        refresh_token: token.raw,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        user: { id: user.id, email: user.email, full_name: user.full_name },
        store: { id: grant.store_id, code: grant.code, name: grant.name, timezone: grant.timezone, currency: grant.currency },
        role: grant.role,
      });
    }),
  );

  r.post('/refresh', asyncHandler(async (req, res) => {
    const body = parse(z.object({ refresh_token: z.string().min(10) }), req.body);
    const rotated = await rotateRefreshToken(ctx.db, body.refresh_token);

    const grants = await ctx.db.query<{ store_id: string; role: Role }>(
      'SELECT store_id, role FROM role_grant WHERE user_id = $1 ORDER BY created_at LIMIT 1',
      [rotated.userId],
    );
    const grant = grants.rows[0];
    if (!grant) throw unauthenticated('STORE_ACCESS_DENIED', 'No store grant for this account.');

    const accessToken = await signAccessToken(ctx.keys, {
      sub: rotated.userId, role: grant.role, storeId: grant.store_id,
    });
    ok(res, {
      access_token: accessToken,
      refresh_token: rotated.raw,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    });
  }));

  r.post('/logout', asyncHandler(async (req, res) => {
    const body = parse(z.object({ refresh_token: z.string().min(10) }), req.body);
    const { sha256 } = await import('../shared/security.js');
    const hash = sha256(body.refresh_token);
    await ctx.db.query(
      `UPDATE refresh_token SET revoked_at = now()
        WHERE family_id = (SELECT family_id FROM refresh_token WHERE token_hash = $1)`,
      [hash],
    );
    ok(res, { revoked: true });
  }));

  r.get('/users/me', authenticate(ctx), asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query<{ id: string; email: string; full_name: string }>(
      'SELECT id, email, full_name FROM app_user WHERE id = $1',
      [req.auth.userId],
    );
    const grants = await ctx.db.query<{ store_id: string; role: Role; code: string; name: string }>(
      `SELECT g.store_id, g.role, s.code, s.name FROM role_grant g JOIN store s ON s.id = g.store_id
        WHERE g.user_id = $1`,
      [req.auth.userId],
    );
    ok(res, { ...rows.rows[0], role: req.auth.role, store_id: req.auth.storeId, grants: grants.rows });
  }));

  r.get('/users', authenticate(ctx), asyncHandler<AuthedRequest>(async (req, res) => {
    if (req.auth.role !== 'OWNER') throw unauthenticated('FORBIDDEN', 'Owner role required.');
    const rows = await ctx.db.query(
      `SELECT u.id, u.email, u.full_name, u.is_active, g.role, g.store_id
         FROM app_user u LEFT JOIN role_grant g ON g.user_id = u.id
        ORDER BY u.created_at`,
    );
    ok(res, rows.rows);
  }));

  r.post('/users', authenticate(ctx), asyncHandler<AuthedRequest>(async (req, res) => {
    if (req.auth.role !== 'OWNER') throw unauthenticated('FORBIDDEN', 'Owner role required.');
    const body = parse(newUser, req.body);
    const passwordHash = await hashPassword(body.password);
    const inserted = await ctx.db.query<{ id: string }>(
      'INSERT INTO app_user (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id',
      [body.email.toLowerCase(), passwordHash, body.full_name],
    );
    const userId = inserted.rows[0]?.id ?? '';
    await ctx.db.query(
      'INSERT INTO role_grant (user_id, store_id, role) VALUES ($1,$2,$3)',
      [userId, req.auth.storeId, body.role],
    );
    await audit(ctx.db, {
      storeId: req.auth.storeId, actorId: req.auth.userId, action: 'user.create',
      entity: 'app_user', entityId: userId, changes: { email: body.email, role: body.role },
    });
    created(res, { id: userId, email: body.email, role: body.role });
  }));

  return r;
}
