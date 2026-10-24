/* An aircraft must depart from where it landed.
 *
 * A leg whose destination is undecided is carried as two options, and
 * consecutive undecided legs form a chain: option A lands where the next
 * leg's option A departs, and B likewise. An operator has to stay on one
 * option across the chain or they land at one airport and depart from
 * another.
 *
 * Everyone on WF2631/WF2632 ended up landing at EGKB and departing from
 * EGSS, so the chain was not being enforced for bookings that already
 * existed when the allocation was set.
 *
 * This walks each operator's legs in running order and, where two adjacent
 * legs do not join up, moves the later booking onto the sibling option that
 * departs from where they actually land. It moves with an UPDATE, so the
 * booking keeps its id, route assignment, reserved flag and manual flag.
 *
 *   node scripts/fix-chain-consistency.js           # dry run, writes nothing
 *   node scripts/fix-chain-consistency.js --push    # apply
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
  const eventId = (await c.query('SELECT id FROM "WfEvent" WHERE "isActive" = true LIMIT 1')).rows[0].id;
  const sched = (await c.query(
    'SELECT number, "from", "to", "dateUtc", "depTimeUtc", "sortOrder", "variantOf" FROM "WfScheduleRow" WHERE "eventId" = $1',
    [eventId]
  )).rows;

  const byRoute = new Map(sched.map(r => [`${r.from}|${r.to}`, r]));
  // Every option of a leg, keyed by the leg's primary number.
  const optionsOf = (row) => {
    const primary = row.variantOf || row.number;
    return sched.filter(r => r.number === primary || r.variantOf === primary);
  };

  const bookings = (await c.query(
    'SELECT id, cid, callsign, "slotKey", "from", "to" FROM "TobtBooking"'
  )).rows;

  const byCallsign = new Map();
  for (const b of bookings) {
    const row = byRoute.get(`${b.from}|${b.to}`);
    if (!row) continue;
    const cs = String(b.callsign || '').toUpperCase();
    if (!byCallsign.has(cs)) byCallsign.set(cs, []);
    byCallsign.get(cs).push({ b, row });
  }

  const moves = [];
  for (const [cs, legs] of byCallsign) {
    legs.sort((x, y) => x.row.sortOrder - y.row.sortOrder);
    for (let i = 0; i < legs.length - 1; i++) {
      const cur = legs[i];
      const next = legs[i + 1];
      if (next.row.sortOrder !== cur.row.sortOrder + 1) continue;   // not adjacent, no chain
      if (cur.row.to === next.row.from) continue;                   // already joins up

      // The option of the next leg that departs where this one lands.
      const target = optionsOf(next.row).find(o => o.from === cur.row.to);
      if (!target) {
        console.log(`SKIP  ${cs}: ${cur.row.number} lands ${cur.row.to}, but ${next.row.number} has no option departing there`);
        continue;
      }
      const newSlotKey = String(next.b.slotKey).replace(
        `${next.row.from}-${next.row.to}|`,
        `${target.from}-${target.to}|`
      );
      console.log(`MOVE  ${cs.padEnd(10)} lands ${cur.row.to} -> ${next.row.number} ${next.row.from}-${next.row.to} becomes ${target.number} ${target.from}-${target.to}`);
      moves.push({ id: next.b.id, from: target.from, to: target.to, slotKey: newSlotKey });
    }
  }

  console.log(`\n${moves.length} booking(s) to move`);

  if (!APPLY) {
    console.log('(dry run - nothing written. Re-run with --push to apply)');
  } else {
    for (const m of moves) {
      await c.query(
        'UPDATE "TobtBooking" SET "from" = $1, "to" = $2, "slotKey" = $3 WHERE id = $4',
        [m.from, m.to, m.slotKey, m.id]
      );
    }
    console.log(`APPLIED: ${moves.length} booking(s) moved.`);
    console.log('Restart the app so the in-memory booking cache is rebuilt.');
  }
} finally {
  await c.end();
}
