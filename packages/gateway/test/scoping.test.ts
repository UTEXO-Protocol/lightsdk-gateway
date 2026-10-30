import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../src/auth.js';
import { openDb, type GatewayDb } from '../src/db.js';
import {
  filterOwned,
  ownerOf,
  OwnershipConflictError,
  recordOwnership,
  updateResourceState,
} from '../src/scoping.js';

describe('resource ownership', () => {
  let db: GatewayDb;
  let alice: string;
  let bob: string;

  beforeEach(() => {
    db = openDb(':memory:');
    alice = createUser(db).userId;
    bob = createUser(db).userId;
  });

  afterEach(() => {
    db.close();
  });

  it('records ownership at creation time and resolves the owner', () => {
    recordOwnership(db, { kind: 'invoice', resourceId: 'hash1', userId: alice, state: 'pending' });
    expect(ownerOf(db, 'invoice', 'hash1')).toBe(alice);
    expect(ownerOf(db, 'invoice', 'hash1')).not.toBe(bob);
    expect(ownerOf(db, 'payment_hash', 'hash1')).toBeUndefined();
  });

  it('lets the owner re-record with a new state but never transfers ownership', () => {
    recordOwnership(db, { kind: 'invoice', resourceId: 'hash1', userId: alice, state: 'pending' });
    recordOwnership(db, { kind: 'invoice', resourceId: 'hash1', userId: alice, state: 'settled' });
    const row = db
      .prepare("SELECT state FROM resource_map WHERE kind = 'invoice' AND resource_id = 'hash1'")
      .get() as { state: string };
    expect(row.state).toBe('settled');
    expect(() =>
      recordOwnership(db, { kind: 'invoice', resourceId: 'hash1', userId: bob, state: 'pending' }),
    ).toThrow(OwnershipConflictError);
    expect(ownerOf(db, 'invoice', 'hash1')).toBe(alice);
  });

  it('updates state only for the owner', () => {
    recordOwnership(db, {
      kind: 'payment_hash',
      resourceId: 'hash2',
      userId: alice,
      state: 'pending',
    });
    expect(updateResourceState(db, 'payment_hash', 'hash2', bob, 'settled')).toBe(false);
    expect(updateResourceState(db, 'payment_hash', 'hash2', alice, 'settled')).toBe(true);
    const row = db
      .prepare(
        "SELECT state FROM resource_map WHERE kind = 'payment_hash' AND resource_id = 'hash2'",
      )
      .get() as { state: string };
    expect(row.state).toBe('settled');
  });

  it('filterOwned drops items with missing or empty ids', () => {
    recordOwnership(db, { kind: 'invoice', resourceId: 'x', userId: alice, state: 'pending' });
    const items = [{ id: 'x' }, { id: '' }, { id: null }, { id: undefined }];
    const kept = filterOwned(db, alice, ['invoice'], items, (item) => item.id);
    expect(kept).toEqual([{ id: 'x' }]);
  });
});
