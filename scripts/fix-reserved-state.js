/* Repairs the two things the reserved-placeholder bugs left in the data.
 *
 * 1. A placeholder moved by rebalanceSlottedSectors lost its `reserved` flag,
 *    because a move is a delete + create and the create did not restate it.
 *    Any booking still held under a manual-callsign affiliate's BASE callsign
 *    is a placeholder by definition, so re-flag it.
 *
 * 2. Auto-assign re-created a placeholder for a sector a named aircraft had
 *    already taken over: the "already booked" test matched only the base
 *    callsign, so once AFR360 held WF2603 the operator looked unbooked and was
 *    handed a second place under AFV. Drop the placeholder wherever one of the
 *    operator's own named aircraft already holds that sector.
 *
 * Both causes are fixed in index.js; this only clears up what they produced.
 *
 *   node scripts/fix-reserved-state.js           # dry run, writes nothing
 *   node scripts/fix-reserved-state.js --push    # apply
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
  const affs = (await c.query(
    'SELECT id, cid, callsign, COALESCE(name, callsign) AS who FROM "Affiliate" WHERE "manualCallsigns" = true'
  )).rows;

  const sched = (await c.query(
    'SELECT number, "from", "to", "dateUtc", "depTimeUtc" FROM "WfScheduleRow"'
    + ' WHERE "eventId" = (SELECT id FROM "WfEvent" WHERE "isActive" = true LIMIT 1)'
  )).rows;
  const prefixOf = (n) => {
    const r = sched.find((x) => x.number === n);
    return r ? `${r.from}-${r.to}|${r.dateUtc}|${r.depTimeUtc}` : null;
  };

  const reflag = [];
  const drop = [];

  for (const a of affs) {
    const base = String(a.callsign || '').toUpperCase();

    // (1) Placeholders that lost the flag.
    const held = (await c.query(
      'SELECT id, "slotKey", "tobtTimeUtc", reserved FROM "TobtBooking" WHERE callsign = $1 AND cid = $2',
      [base, a.cid]
    )).rows;
    for (const b of held.filter((x) => !x.reserved)) {
      console.log(`RE-FLAG  ${a.who}: ${base} ${b.slotKey} -> reserved`);
      reflag.push(b.id);
    }

    // (2) Placeholders on a sector one of this operator's named aircraft holds.
    const named = (await c.query(
      'SELECT "sectorNumber", callsign FROM "AffiliateSectorClaim"'
      + ' WHERE "affiliateId" = $1 AND callsign IS NOT NULL',
      [a.id]
    )).rows;
    for (const n of named) {
      const prefix = prefixOf(n.sectorNumber);
      if (!prefix) continue;
      const aircraft = (await c.query(
        'SELECT id FROM "TobtBooking" WHERE "slotKey" LIKE $1 AND callsign = $2',
        [`${prefix}%`, String(n.callsign).toUpperCase()]
      )).rows;
      if (!aircraft.length) continue;          // nothing took it over; keep the placeholder
      const stray = held.filter((b) => String(b.slotKey).startsWith(prefix));
      for (const b of stray) {
        console.log(`DROP     ${a.who}: ${base} ${b.slotKey} - ${n.callsign} already holds this sector`);
        drop.push(b.id);
      }
    }
  }

  const reflagging = reflag.filter((id) => !drop.includes(id));
  console.log(`\n${reflagging.length} placeholder(s) to re-flag, ${drop.length} stray placeholder(s) to drop`);

  if (!APPLY) {
    console.log('(dry run - nothing written. Re-run with --push to apply)');
  } else {
    if (reflagging.length) {
      await c.query('UPDATE "TobtBooking" SET reserved = true WHERE id = ANY($1)', [reflagging]);
    }
    if (drop.length) {
      await c.query('DELETE FROM "TobtBooking" WHERE id = ANY($1)', [drop]);
    }
    console.log(`APPLIED: ${reflagging.length} re-flagged, ${drop.length} dropped.`);
    console.log('Restart the app so the in-memory booking cache is rebuilt.');
  }
} finally {
  await c.end();
}
