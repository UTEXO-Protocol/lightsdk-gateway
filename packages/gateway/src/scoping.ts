/**
 * User↔resource ownership records (invariant I3: one user must never see
 * another user's resources).
 *
 * The gateway records ownership in resource_map at creation time — the
 * recipient id of every receive and the txid of every asset send — so any
 * listing that is not already per-user can be filtered before it leaves the
 * gateway.
 */
import type { GatewayDb } from './db.js';

export type ResourceKind = 'invoice' | 'payment_hash' | 'asset_transfer' | 'swap';

export interface ResourceRecord {
  kind: ResourceKind;
  resourceId: string;
  userId: string;
  state: string;
}

/** Ownership is claimed by a different user — a bug or an attack, never expected. */
export class OwnershipConflictError extends Error {
  constructor(
    readonly kind: ResourceKind,
    readonly resourceId: string,
  ) {
    super(`resource ${kind}:${resourceId} is already owned by another user`);
    this.name = 'OwnershipConflictError';
  }
}

/**
 * Record that a resource belongs to a user, at creation time. Re-recording by
 * the same owner updates the state; a different owner is a hard error
 * (ownership never transfers).
 */
export function recordOwnership(
  db: GatewayDb,
  record: ResourceRecord,
  now: number = Date.now(),
): void {
  const existing = ownerOf(db, record.kind, record.resourceId);
  if (existing !== undefined && existing !== record.userId) {
    throw new OwnershipConflictError(record.kind, record.resourceId);
  }
  db.prepare(
    `INSERT INTO resource_map (kind, resource_id, user_id, state, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, resource_id) DO UPDATE SET state = excluded.state
     WHERE resource_map.user_id = excluded.user_id`,
  ).run(record.kind, record.resourceId, record.userId, record.state, now);
}

export function ownerOf(db: GatewayDb, kind: ResourceKind, resourceId: string): string | undefined {
  const row = db
    .prepare('SELECT user_id FROM resource_map WHERE kind = ? AND resource_id = ?')
    .get(kind, resourceId) as { user_id: string } | undefined;
  return row?.user_id;
}

/** Update the tracked state of an owned resource (no-op for foreign/unknown ones). */
export function updateResourceState(
  db: GatewayDb,
  kind: ResourceKind,
  resourceId: string,
  userId: string,
  state: string,
): boolean {
  const result = db
    .prepare('UPDATE resource_map SET state = ? WHERE kind = ? AND resource_id = ? AND user_id = ?')
    .run(state, kind, resourceId, userId);
  return result.changes === 1;
}

/**
 * Keep only items whose id resolves to a resource the user owns under one of
 * the given kinds. Items with no extractable id are dropped: unattributable
 * node-wide state must never leak.
 */
export function filterOwned<T>(
  db: GatewayDb,
  userId: string,
  kinds: readonly ResourceKind[] | ((item: T) => readonly ResourceKind[]),
  items: readonly T[],
  idOf: (item: T) => string | null | undefined,
): T[] {
  const statement = db.prepare(
    'SELECT 1 FROM resource_map WHERE kind = ? AND resource_id = ? AND user_id = ?',
  );
  const kindsOf = typeof kinds === 'function' ? kinds : (): readonly ResourceKind[] => kinds;
  return items.filter((item) => {
    const id = idOf(item);
    if (id === null || id === undefined || id === '') return false;
    return kindsOf(item).some((kind) => statement.get(kind, id, userId) !== undefined);
  });
}
