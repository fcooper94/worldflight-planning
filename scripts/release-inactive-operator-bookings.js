/* Hand back places held by operators who are no longer taking part.
 *
 * Turning participation ON ran auto-assignment; turning it OFF did nothing,
 * so an operator marked not participating kept every slot they had been
 * allocated — out of the pool, still in the VATCAN list, and the sector
 * reading as fuller than it was.
 *
 * index.js now releases on deactivate (releaseBookingsForCallsign). This
 * clears up what the old behaviour left behind.
 *
 *   node scripts/release-inactive-operator-bookings.js           # dry run
 *   node scripts/release-inactive-operator-bookings.js --push    # apply
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
  const inactive = (await c.query(`
    SELECT COALESCE(name, callsign) AS who, callsign, 'affiliate' AS kind
      FROM "Affiliate" WHERE "participatingWf26" = false AND callsign IS NOT NULL
    UNION ALL
    SELECT "teamName", callsign, 'team'
      FROM "OfficialTeam" WHERE "participatingWf26" = false AND callsign IS NOT NULL
  `)).rows;

  // An operator can appear twice (a fleet shares a name); match on callsign.
  const byCallsign = new Map();
  for (const o of inactive) {
    const cs = String(o.callsign || '').toUpperCase();
    if (cs && !byCallsign.has(cs)) byCallsign.set(cs, o);
  }

  let total = 0;
  const ids = [];
  for (const [cs, o] of byCallsign) {
    const rows = (await c.query(
      'SELECT id, "slotKey" FROM "TobtBooking" WHERE UPPER(callsign) = $1 ORDER BY "slotKey"',
      [cs]
    )).rows;
    if (!rows.length) continue;
    console.log(`${cs.padEnd(12)} ${String(rows.length).padStart(3)} place(s)   ${o.who} (${o.kind}, not participating)`);
    rows.forEach(r => ids.push(r.id));
    total += rows.length;
  }

  console.log(`\n${total} booking(s) to release from ${byCallsign.size} inactive operator(s)`);

  if (!APPLY) {
    console.log('(dry run - nothing written. Re-run with --push to apply)');
  } else if (ids.length) {
    await c.query('DELETE FROM "TobtBooking" WHERE id = ANY($1)', [ids]);
    console.log(`APPLIED: ${ids.length} booking(s) released.`);
    console.log('Restart the app so the in-memory booking cache is rebuilt.');
  }
} finally {
  await c.end();
}
