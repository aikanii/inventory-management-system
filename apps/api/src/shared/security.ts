/**
 * Authentication, authorization and audit.
 *
 * Passwords are Argon2id. Access tokens are RS256 JWTs signed with a key pair
 * generated on first boot and stored in the `setting` table, so a fresh
 * instance is self-provisioning. Refresh tokens are opaque, hashed at rest and
 * rotate within a family — replaying a rotated token revokes the whole family.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Database } from '../db/database.js';
import { ApiError, forbidden, storeAccessDenied, unauthenticated } from './errors.js';

export type Role = 'OWNER' | 'MANAGER' | 'CASHIER' | 'VIEWER';

export type Permission =
  | 'catalog:read' | 'catalog:write'
  | 'stock:read' | 'stock:write'
  | 'sales:create' | 'sales:return' | 'sales:void' | 'sales:read'
  | 'purchasing:write' | 'purchasing:read'
  | 'expenses:write'
  | 'reports:all' | 'reports:own'
  | 'ai:use'
  | 'users:manage' | 'audit:read';

const OWNER: readonly Permission[] = [
  'catalog:read', 'catalog:write', 'stock:read', 'stock:write',
  'sales:create', 'sales:return', 'sales:void', 'sales:read',
  'purchasing:write', 'purchasing:read', 'expenses:write',
  'reports:all', 'reports:own', 'ai:use', 'users:manage', 'audit:read',
];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER,
  MANAGER: OWNER.filter((p) => p !== 'users:manage' && p !== 'audit:read'),
  CASHIER: ['catalog:read', 'stock:read', 'sales:create', 'sales:return', 'sales:read', 'reports:own'],
  VIEWER: ['catalog:read', 'stock:read', 'sales:read', 'purchasing:read', 'reports:all', 'ai:use'],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// ---------------------------------------------------------------- passwords

export function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2Verify(hash, plain).catch(() => false);
}

// ---------------------------------------------------------------- keys

export interface JwtKeys {
  privateKey: string;
  publicKey: string;
  kid: string;
}

/** Generate on first boot, then reuse. Stored in `setting`, never on disk in the repo. */
export async function ensureJwtKeys(db: Database): Promise<JwtKeys> {
  const existing = await db.query<{ key: string; value: { pem: string; kid: string } }>(
    `SELECT key, value FROM setting WHERE key IN ('jwt.private', 'jwt.public', 'jwt.kid')`,
  );
  const map = new Map(existing.rows.map((r) => [r.key, r.value]));
  const priv = map.get('jwt.private');
  const pub = map.get('jwt.public');
  const kidRow = map.get('jwt.kid');
  if (priv?.pem && pub?.pem && kidRow?.kid) {
    return { privateKey: priv.pem, publicKey: pub.pem, kid: kidRow.kid };
  }

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const kid = randomUUID();
  await db.transaction(async (tx) => {
    for (const [key, value] of [
      ['jwt.private', { pem: privateKey, kid }],
      ['jwt.public', { pem: publicKey, kid }],
      ['jwt.kid', { pem: '', kid }],
    ] as const) {
      await tx.query(
        `INSERT INTO setting (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    }
  });
  return { privateKey, publicKey, kid };
}

// ---------------------------------------------------------------- tokens

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  storeId: string;
}

export async function signAccessToken(keys: JwtKeys, claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ role: claims.role, store_id: claims.storeId })
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(await importPKCS8(keys.privateKey, 'RS256'));
}

export async function verifyAccessToken(
  keys: JwtKeys,
  token: string,
): Promise<{ sub: string; role: Role; storeId: string }> {
  const { payload } = await jwtVerify(token, await importSPKI(keys.publicKey, 'RS256'), {
    algorithms: ['RS256'],
  });
  const role = payload.role as Role | undefined;
  const storeId = payload.store_id as string | undefined;
  if (!payload.sub || !role || !storeId) throw unauthenticated('TOKEN_INVALID', 'Malformed token.');
  return { sub: payload.sub, role, storeId };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newRefreshToken(): { raw: string; hash: string } {
  const raw = randomUUID() + randomUUID().replace(/-/g, '');
  return { raw, hash: sha256(raw) };
}

/** Replaying an already-rotated token means the token leaked: kill the family. */
export async function rotateRefreshToken(
  db: Database,
  rawToken: string,
): Promise<{ userId: string; familyId: string; raw: string; hash: string; expiresAt: Date }> {
  const hash = sha256(rawToken);
  return db.transaction(async (tx) => {
    const rows = await tx.query<{
      id: string; user_id: string; family_id: string; revoked_at: string | null; replaced_by: string | null;
    }>('SELECT id, user_id, family_id, revoked_at, replaced_by FROM refresh_token WHERE token_hash = $1', [hash]);
    const row = rows.rows[0];
    if (!row) throw unauthenticated('UNAUTHENTICATED', 'Unknown refresh token.');

    if (row.revoked_at || row.replaced_by) {
      await tx.query('UPDATE refresh_token SET revoked_at = now() WHERE family_id = $1', [row.family_id]);
      throw unauthenticated('REFRESH_TOKEN_REUSED', 'Refresh token reuse detected; re-authentication required.');
    }

    const next = newRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await tx.query(
      `INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [row.user_id, row.family_id, next.hash, expiresAt],
    );
    await tx.query('UPDATE refresh_token SET replaced_by = $1 WHERE id = $2', [row.id, row.id]);
    return { userId: row.user_id, familyId: row.family_id, raw: next.raw, hash: next.hash, expiresAt };
  });
}

// ---------------------------------------------------------------- audit

export async function audit(
  db: Database,
  entry: {
    storeId?: string | null;
    actorId?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    changes?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (store_id, actor_id, action, entity, entity_id, changes, ip)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      entry.storeId ?? null,
      entry.actorId ?? null,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      JSON.stringify(entry.changes ?? {}),
      entry.ip ?? null,
    ],
  );
}

export function assertPermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new ApiError(403, 'FORBIDDEN', `Role ${role} lacks permission ${permission}.`);
  }
}

export { forbidden, storeAccessDenied };
