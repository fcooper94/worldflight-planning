/* Record every airport on an event's route as visited that year.
 *
 * Past Destinations (WfVisitedAirport, one row per ICAO per year) is only
 * filled by hand from Admin > Visited Airports. This adds a whole event in
 * one go: every departure and arrival on its schedule. Existing rows for the
 * year are left alone (unique on icao + year), so it is safe to re-run.
 *
 * Route alternatives (rows with variantOf set) are listed but not added
 * unless --include-alternatives is passed: an option nobody flew is not a
 * destination, but on an event where both options were flown (WF2026) they
 * both belong.
 *
 *   node scripts/add-event-visited-airports.js                 # dry run, active event
 *   node scripts/add-event-visited-airports.js --year 2026     # dry run, that year's event
 *   node scripts/add-event-visited-airports.js --include-alternatives
 *   node scripts/add-event-visited-airports.js --push          # apply
 */
import 'dotenv/config';
import pg from 'pg';

const APPLY = process.argv.includes('--push');
const WITH_ALTERNATIVES = process.argv.includes('--include-alternatives');
const yearArg = process.argv.indexOf('--year');
const YEAR = yearArg > -1 ? Number(process.argv[yearArg + 1]) : null;

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
await c.connect();

try {
  const event = (await c.query(
    YEAR
      ? 'SELECT id, name, year FROM "WfEvent" WHERE year = $1'
      : 'SELECT id, name, year FROM "WfEvent" WHERE "isActive" = true',
    YEAR ? [YEAR] : []
  )).rows[0];
  if (!event) throw new Error(YEAR ? `No event for ${YEAR}` : 'No active event');
  console.log(`Event: ${event.name} (${event.year}, id ${event.id})\n`);

  const legs = (await c.query(
    'SELECT number, "from", "to", "variantOf" FROM "WfScheduleRow" WHERE "eventId" = $1 ORDER BY "sortOrder", number',
    [event.id]
  )).rows;

  const flown = legs.filter(l => WITH_ALTERNATIVES || !l.variantOf);
  const alternatives = legs.filter(l => l.variantOf);

  // Route order, each airport once.
  const icaos = [];
  for (const l of flown) {
    for (const raw of [l.from, l.to]) {
      const icao = String(raw || '').trim().toUpperCase();
      if (/^[A-Z0-9]{4}$/.test(icao) && !icaos.includes(icao)) icaos.push(icao);
    }
  }

  const existing = new Set((await c.query(
    'SELECT icao FROM "WfVisitedAirport" WHERE year = $1', [event.year]
  )).rows.map(r => r.icao));

  const toAdd = icaos.filter(i => !existing.has(i));
  const already = icaos.filter(i => existing.has(i));

  console.log(`${flown.length} legs, ${icaos.length} airports on the route`);
  console.log(`Already recorded for ${event.year} (${already.length}): ${already.join(' ') || '-'}`);
  console.log(`To add (${toAdd.length}): ${toAdd.join(' ') || '-'}`);
  if (alternatives.length) {
    console.log(`\n${WITH_ALTERNATIVES ? 'Included' : 'Skipped'} route alternatives (${alternatives.length}):`);
    alternatives.forEach(l => console.log(`  ${l.number}  ${l.from} -> ${l.to}  (option of ${l.variantOf})`));
  }

  if (!APPLY) {
    console.log('\n(dry run - nothing written. Re-run with --push to apply)');
  } else if (toAdd.length) {
    const res = await c.query(
      `INSERT INTO "WfVisitedAirport" (icao, year, "eventName")
       SELECT unnest($1::text[]), $2, 'WorldFlight'
       ON CONFLICT (icao, year) DO NOTHING`,
      [toAdd, event.year]
    );
    const count = (await c.query('SELECT COUNT(*)::int AS n FROM "WfVisitedAirport" WHERE year = $1', [event.year])).rows[0].n;
    console.log(`\nAPPLIED: ${res.rowCount} airport(s) added. ${count} recorded for ${event.year} in total.`);
  }
} finally {
  await c.end();
}
