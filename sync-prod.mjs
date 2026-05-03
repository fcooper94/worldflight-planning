/**
 * Two-way sync for CID 1303570 between local SQLite (dev) and production Postgres.
 *
 * Rules:
 *   - Production is master by default.
 *   - If a local record is newer (by createdAt), push it to production.
 *   - New records that only exist locally get pushed to production.
 *   - Everything from production is then pulled into local.
 */

import { readFileSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import pkg from 'pg';

const CID = 1303570;
const { Client } = pkg;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function ts(v) { return v ? new Date(v).getTime() : 0; }
function newer(localTs, prodTs) { return ts(localTs) > ts(prodTs) + 1000; } // 1s tolerance

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

const devEnv = loadEnvFile('.env.dev');
const prodUrl = devEnv.PROD_DATABASE_URL;
if (!prodUrl) {
  console.error('  ERROR: PROD_DATABASE_URL not set in .env.dev');
  process.exit(1);
}

const dbPath = 'prisma/dev.db';
if (!existsSync(dbPath)) {
  console.log('  No local dev.db found — nothing to sync.');
  process.exit(0);
}

const pg = new Client({ connectionString: prodUrl });
await pg.connect();
const lite = new Database(dbPath);

console.log('  Syncing CID', CID, '...');

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

const localUser = lite.prepare('SELECT * FROM User WHERE cid = ?').get(CID);
const prodUser = (await pg.query('SELECT * FROM "User" WHERE cid = $1', [CID])).rows[0];

if (localUser && !prodUser) {
  await pg.query('INSERT INTO "User" (cid, name) VALUES ($1, $2)', [CID, localUser.name]);
  console.log('    User → pushed to production');
} else if (prodUser) {
  lite.prepare('INSERT INTO User (cid, name) VALUES (?, ?) ON CONFLICT(cid) DO UPDATE SET name = ?')
    .run(CID, prodUser.name, prodUser.name);
  console.log('    User ✓');
}

// ---------------------------------------------------------------------------
// UserAdditionalRole  (keyed by cid + role)
// ---------------------------------------------------------------------------

const localRoles = lite.prepare('SELECT * FROM UserAdditionalRole WHERE cid = ?').all(CID);
const prodRoles = (await pg.query('SELECT * FROM "UserAdditionalRole" WHERE cid = $1', [CID])).rows;

const prodRoleMap = Object.fromEntries(prodRoles.map(r => [r.role, r]));
const localRoleMap = Object.fromEntries(localRoles.map(r => [r.role, r]));

// Push local-only or newer-local roles to prod
for (const lr of localRoles) {
  const pr = prodRoleMap[lr.role];
  if (!pr) {
    await pg.query(
      `INSERT INTO "UserAdditionalRole" (cid, role, "teamName", "canEditBookings", "canManageMembers", participating)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [CID, lr.role, lr.teamName, lr.canEditBookings, lr.canManageMembers, lr.participating]
    );
    console.log(`    Role ${lr.role} → pushed to production (new)`);
  } else if (newer(lr.createdAt, pr.createdAt)) {
    await pg.query(
      `UPDATE "UserAdditionalRole"
       SET "teamName"=$1, "canEditBookings"=$2, "canManageMembers"=$3, participating=$4
       WHERE cid=$5 AND role=$6`,
      [lr.teamName, lr.canEditBookings, lr.canManageMembers, lr.participating, CID, lr.role]
    );
    console.log(`    Role ${lr.role} → pushed to production (newer)`);
  }
}

// Pull all prod roles to local (prod is master)
for (const pr of prodRoles) {
  lite.prepare(
    `INSERT INTO UserAdditionalRole (cid, role, teamName, canEditBookings, canManageMembers, participating, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cid, role) DO UPDATE SET
       teamName=excluded.teamName,
       canEditBookings=excluded.canEditBookings,
       canManageMembers=excluded.canManageMembers,
       participating=excluded.participating,
       createdAt=excluded.createdAt`
  ).run(CID, pr.role, pr.teamName, pr.canEditBookings ? 1 : 0, pr.canManageMembers ? 1 : 0,
        pr.participating ? 1 : 0, new Date(pr.createdAt).toISOString());
}

// Remove local roles that no longer exist in prod
for (const lr of localRoles) {
  if (!prodRoleMap[lr.role]) {
    lite.prepare('DELETE FROM UserAdditionalRole WHERE cid = ? AND role = ?').run(CID, lr.role);
    console.log(`    Role ${lr.role} → removed locally (deleted in prod)`);
  }
}
console.log(`    Roles ✓ (${prodRoles.length} synced)`);

// ---------------------------------------------------------------------------
// DocumentationPermission  (keyed by cid + pattern)
// ---------------------------------------------------------------------------

const localPerms = lite.prepare('SELECT * FROM DocumentationPermission WHERE cid = ?').all(CID);
const prodPerms = (await pg.query('SELECT * FROM "DocumentationPermission" WHERE cid = $1', [CID])).rows;

const prodPermSet = new Set(prodPerms.map(p => p.pattern));
const localPermSet = new Set(localPerms.map(p => p.pattern));

// Push local-only perms to prod
for (const lp of localPerms) {
  if (!prodPermSet.has(lp.pattern)) {
    await pg.query(
      'INSERT INTO "DocumentationPermission" (cid, pattern) VALUES ($1, $2)',
      [CID, lp.pattern]
    );
    console.log(`    DocPerm "${lp.pattern}" → pushed to production`);
  }
}

// Pull prod perms to local
for (const pp of prodPerms) {
  if (!localPermSet.has(pp.pattern)) {
    lite.prepare('INSERT INTO DocumentationPermission (cid, pattern, createdAt) VALUES (?, ?, ?)')
      .run(CID, pp.pattern, new Date(pp.createdAt).toISOString());
  }
}

// Remove local perms deleted in prod
for (const lp of localPerms) {
  if (!prodPermSet.has(lp.pattern)) {
    // Already pushed above, don't remove
  }
}
console.log(`    DocPerms ✓ (${prodPerms.length} in prod)`);

// ---------------------------------------------------------------------------
// TobtBooking  (keyed by cid + slotKey)
// ---------------------------------------------------------------------------

const localBookings = lite.prepare('SELECT * FROM TobtBooking WHERE cid = ?').all(CID);
const prodBookings = (await pg.query('SELECT * FROM "TobtBooking" WHERE cid = $1', [CID])).rows;

const prodBookMap = Object.fromEntries(prodBookings.map(b => [b.slotKey, b]));
const localBookMap = Object.fromEntries(localBookings.map(b => [b.slotKey, b]));

// Push local-only or newer bookings to prod
for (const lb of localBookings) {
  const pb = prodBookMap[lb.slotKey];
  if (!pb) {
    await pg.query(
      `INSERT INTO "TobtBooking" ("slotKey", cid, callsign, "from", "to", "dateUtc", "depTimeUtc", "tobtTimeUtc", manual)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [lb.slotKey, CID, lb.callsign, lb.from, lb.to, lb.dateUtc, lb.depTimeUtc, lb.tobtTimeUtc, lb.manual || false]
    );
    console.log(`    Booking ${lb.slotKey} → pushed to production (new)`);
  } else if (newer(lb.createdAt, pb.createdAt)) {
    await pg.query(
      `UPDATE "TobtBooking"
       SET callsign=$1, "from"=$2, "to"=$3, "dateUtc"=$4, "depTimeUtc"=$5, "tobtTimeUtc"=$6, manual=$7
       WHERE cid=$8 AND "slotKey"=$9`,
      [lb.callsign, lb.from, lb.to, lb.dateUtc, lb.depTimeUtc, lb.tobtTimeUtc, lb.manual || false, CID, lb.slotKey]
    );
    console.log(`    Booking ${lb.slotKey} → pushed to production (newer)`);
  }
}

// Pull all prod bookings to local
for (const pb of prodBookings) {
  lite.prepare(
    `INSERT INTO TobtBooking (slotKey, cid, callsign, "from", "to", dateUtc, depTimeUtc, tobtTimeUtc, manual, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cid, slotKey) DO UPDATE SET
       callsign=excluded.callsign,
       "from"=excluded."from",
       "to"=excluded."to",
       dateUtc=excluded.dateUtc,
       depTimeUtc=excluded.depTimeUtc,
       tobtTimeUtc=excluded.tobtTimeUtc,
       manual=excluded.manual,
       createdAt=excluded.createdAt`
  ).run(pb.slotKey, CID, pb.callsign, pb.from, pb.to, pb.dateUtc, pb.depTimeUtc, pb.tobtTimeUtc,
        pb.manual ? 1 : 0, new Date(pb.createdAt).toISOString());
}

// Remove local bookings deleted in prod
for (const lb of localBookings) {
  if (!prodBookMap[lb.slotKey]) {
    lite.prepare('DELETE FROM TobtBooking WHERE cid = ? AND slotKey = ?').run(CID, lb.slotKey);
    console.log(`    Booking ${lb.slotKey} → removed locally (deleted in prod)`);
  }
}
console.log(`    Bookings ✓ (${prodBookings.length} in prod)`);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

lite.close();
await pg.end();
console.log('  Sync complete.');
