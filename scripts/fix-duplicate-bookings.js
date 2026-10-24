/* One operator may hold only one place per sector.
 *
 * Renaming a team or affiliate used to leave its bookings behind: auto-assign
 * matches "already booked" by callsign, so the operator looked unbooked and
 * was allocated a SECOND place while the first sat under the old name. On a
 * Booking Required sector the (cid, slotKey) unique index hid that, because
 * every booking there shares one slotKey; on a slotted sector each TCT is its
 * own slotKey, so the duplicate went straight through.
 *
 * The rename path now carries its bookings over (renameBookingsForCallsign in
 * index.js), so this only cleans up what the old behaviour left behind.
 *
 * For each (cid, sector) group holding more than one booking it keeps the
 * EARLIEST slot - the one they had before the split, and on a slotted sector
 * the better slot - renames it to the operator's currently registered
 * callsign, and drops the rest.
 *
 *   node scripts/fix-duplicate-bookings.js           # dry run, writes nothing
 *   node scripts/fix-duplicate-bookings.js --push    # apply
 */
import 'dotenv/config';
import pg from 'pg';

const APPLY = process.argv.includes('--push');

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
await c.connect();

try {
  const teams = (await c.query('SELECT "mainCid" AS cid, callsign, "teamName" AS who FROM "OfficialTeam"')).rows;
  const affs = (await c.query('SELECT cid, callsign, COALESCE(name, callsign) AS who FROM "Affiliate"')).rows;

  // A CID may own several rows (a fleet); only an operator with exactly one
  // registered callsign gets its kept booking renamed.
  const registered = new Map();
  for (const r of [...teams, ...affs]) {
    const k = Number(r.cid);
    if (!registered.has(k)) registered.set(k, []);
    registered.get(k).push({ cs: String(r.callsign || '').toUpperCase(), who: r.who });
  }

  const rows = (await c.query(
    'SELECT id, cid, callsign, "slotKey", "tobtTimeUtc" FROM "TobtBooking"'
  )).rows;

  // Group by operator + sector. The sector is the slotKey without its slot:
  // FROM-TO|date|depTime.
  const groups = new Map();
  for (const b of rows) {
    const p = String(b.slotKey).split('|');
    const key = `${b.cid}|${p[0]}|${p[1]}|${p[2]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const renames = [];
  const drops = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.tobtTimeUtc || '').localeCompare(String(b.tobtTimeUtc || '')));

    const cid = Number(group[0].cid);
    const owners = registered.get(cid) || [];
    const keep = group[0];
    const target = owners.length === 1 ? owners[0].cs : null;
    const who = owners.length ? owners[0].who : '(not a team/affiliate main CID)';

    console.log(`${key.split('|').slice(1).join('|')}   cid ${cid}   ${who}`);
    const rename = target && target !== String(keep.callsign).toUpperCase();
    console.log(`   KEEP   ${String(keep.callsign).padEnd(10)} @${keep.tobtTimeUtc || '-'}`
      + (rename ? `   -> rename to ${target}` : ''));
    if (rename) renames.push({ id: keep.id, cs: target });

    for (const d of group.slice(1)) {
      console.log(`   DROP   ${String(d.callsign).padEnd(10)} @${d.tobtTimeUtc || '-'}`);
      drops.push({ id: d.id, slotKey: d.slotKey, callsign: d.callsign });
    }
  }

  console.log(`\n${renames.length} booking(s) to rename, ${drops.length} duplicate(s) to drop`);

  if (!APPLY) {
    console.log('(dry run - nothing written. Re-run with --push to apply)');
  } else {
    for (const r of renames) {
      await c.query('UPDATE "TobtBooking" SET callsign=$1 WHERE id=$2', [r.cs, r.id]);
    }
    for (const d of drops) {
      await c.query('DELETE FROM "TobtBooking" WHERE id=$1', [d.id]);
    }
    console.log(`APPLIED: ${renames.length} renamed, ${drops.length} dropped.`);
    console.log('Restart the server (or let it reload) so the in-memory booking cache is rebuilt.');
  }
} finally {
  await c.end();
}
