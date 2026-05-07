/**
 * Push WfVisitedAirport rows for years 2006, 2009, 2010, 2011, 2012
 * directly into the production Postgres DB.
 *
 * Uses ON CONFLICT (icao, year) DO NOTHING — never overrides existing rows.
 *
 * Usage:
 *   node scripts/push-wf-years-to-prod.mjs           # dry-run (default)
 *   node scripts/push-wf-years-to-prod.mjs --push    # actually write
 *
 * Reads PROD_DATABASE_URL from .env.dev.
 */

import { readFileSync, existsSync } from 'fs';
import pkg from 'pg';

const { Client } = pkg;
const PUSH = process.argv.includes('--push');

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const devEnv = loadEnvFile('.env.dev');
const prodUrl = devEnv.PROD_DATABASE_URL;
if (!prodUrl) {
  console.error('  ERROR: PROD_DATABASE_URL not set in .env.dev');
  process.exit(1);
}

const EVENT_NAME = 'WorldFlight';

const ROUTES = {
  2006: [
    'YSSY', 'NFFN', 'PHNL', 'KSAN', 'KRNO', 'KPDX', 'CYYC', 'CYWG',
    'KORD', 'KBNA', 'KMSY', 'MUHA', 'TNCC', 'TXKF', 'LPAZ', 'LPPR',
    'EGKK', 'EGPH', 'ENGM', 'EDDM', 'LYBE', 'LTBA', 'OSDI', 'HEGN',
    'HSPN', 'HDAM', 'HUEN', 'FVHA', 'FADN', 'FMMI', 'FSIA', 'VCBI',
    'VYYY', 'ZPPP', 'ZLLL', 'ZBAA', 'ZKPY', 'RJBB', 'VHHH', 'VVTS',
    'WAMM', 'AYPY', 'YPDN', 'YBAS', 'YBBN'
  ],
  2009: [
    'YSSY', 'YPPH', 'YPLM', 'FJDG', 'VCBI', 'VANP', 'VIDP', 'UAFM',
    'UACC', 'UNBB', 'USSS', 'UWWW', 'UMMS', 'UUWW', 'ULLI', 'EVRA',
    'EPWA', 'LUKK', 'LBSF', 'LOWW', 'EGLF', 'LFRS', 'EIDW', 'LPAZ',
    'GMME', 'TXKF', 'KIAD', 'KDTW', 'KFAR', 'KMCI', 'KGTF', 'CYEG',
    'PANC', 'UHMM', 'UHWW', 'RJOO', 'RODN', 'VHHH', 'RPLB', 'PGUM',
    'AYPY', 'YPDN', 'YBAS', 'YPAD', 'YMML'
  ],
  2010: [
    'YSSY', 'NFFN', 'PHNL', 'KSFO', 'KSEA', 'CYQR', 'KDEN', 'KIAH',
    'MMUN', 'MPTO', 'SEQU', 'SPIM', 'SLLP', 'SGAS', 'SBGL', 'FHAW',
    'FYWH', 'FACT', 'FAJS', 'FVHA', 'HTDA', 'HKJK', 'HSSS', 'HECA',
    'LGRX', 'LIMC', 'LFPO', 'EGKK', 'EGCC', 'EKCH', 'LSZH', 'LYBE',
    'LTBA', 'LLBG', 'OKBK', 'OMDB', 'OPKC', 'VABB', 'VOMM', 'VTBD',
    'WSSS', 'WRRR', 'YPDN', 'YBTL', 'YBBN'
  ],
  2011: [
    'YSSY', 'YPDN', 'WIII', 'VOBG', 'OMAA', 'OYAA', 'OEMA', 'OLBA',
    'LTBJ', 'LIRF', 'LEZL', 'LPLA', 'GCXO', 'GGOV', 'DGAA', 'SBRF',
    'SBBE', 'SMJP', 'SVMI', 'SKBQ', 'TJBQ', 'MKJP', 'MYNN', 'KJAX',
    'KMEM', 'KICT', 'KPIT', 'KBOS', 'CYYR', 'BIKF', 'EGPK', 'ESGG',
    'EYVI', 'UUOK', 'UBBB', 'UTST', 'OPQT', 'VTCC', 'VMMC', 'VDPP',
    'WARR', 'YCIN', 'YPPH', 'YPAD', 'YMML'
  ],
  2012: [
    'YSSY', 'NZAA', 'NSFA', 'PHKO', 'MMTJ', 'MMMX', 'MUHA', 'MDSD',
    'TNCM', 'TTPP', 'GVAC', 'GCFV', 'GMMN', 'DAAG', 'LEMD', 'EGBB',
    'ENGM', 'EFHK', 'EPWA', 'EDDF', 'LATI', 'LUKK', 'LTAC', 'OSDI',
    'OIII', 'UTTT', 'OPLA', 'VANP', 'VNKT', 'VGEG', 'ZUUU', 'ZLLL',
    'ZMUB', 'UEEE', 'UHPP', 'UHWW', 'ZBAA', 'RKSS', 'RJOO', 'RCTP',
    'PGSN', 'WABB', 'AYPY', 'YBCS', 'YBBN'
  ]
};

const pg = new Client({ connectionString: prodUrl });
await pg.connect();

console.log(`  Mode: ${PUSH ? 'PUSH (writing to prod)' : 'DRY-RUN (use --push to actually write)'}`);
console.log('');

let totalInserted = 0, totalSkipped = 0;

for (const [yearStr, icaos] of Object.entries(ROUTES)) {
  const year = Number(yearStr);
  console.log(`  Year ${year} (${icaos.length} airports):`);

  let inserted = 0, skipped = 0;

  for (const icao of icaos) {
    if (!PUSH) {
      // Dry run: just check whether the row already exists
      const { rows } = await pg.query(
        'SELECT 1 FROM "WfVisitedAirport" WHERE icao = $1 AND year = $2 LIMIT 1',
        [icao, year]
      );
      if (rows.length) {
        skipped++;
      } else {
        inserted++;
      }
      continue;
    }

    const result = await pg.query(
      `INSERT INTO "WfVisitedAirport" (icao, year, "eventName")
       VALUES ($1, $2, $3)
       ON CONFLICT (icao, year) DO NOTHING
       RETURNING id`,
      [icao, year, EVENT_NAME]
    );
    if (result.rowCount > 0) {
      inserted++;
    } else {
      skipped++;
    }
  }

  console.log(`    ${PUSH ? 'inserted' : 'would insert'} ${inserted}, skipped (already present) ${skipped}`);
  totalInserted += inserted;
  totalSkipped += skipped;
}

console.log('');
console.log(`  TOTAL: ${PUSH ? 'inserted' : 'would insert'} ${totalInserted}, skipped ${totalSkipped}`);

await pg.end();
