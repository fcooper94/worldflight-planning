import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const YEAR = 2010;
const EVENT_NAME = 'WorldFlight';

// Route order from the WorldFlight 2010 schedule (WF1001-WF1045).
// Sydney appears at start and end; included once.
const ICAOS = [
  'YSSY', 'NFFN', 'PHNL', 'KSFO', 'KSEA', 'CYQR', 'KDEN', 'KIAH',
  'MMUN', 'MPTO', 'SEQU', 'SPIM', 'SLLP', 'SGAS', 'SBGL', 'FHAW',
  'FYWH', 'FACT', 'FAJS', 'FVHA', 'HTDA', 'HKJK', 'HSSS', 'HECA',
  'LGRX', 'LIMC', 'LFPO', 'EGKK', 'EGCC', 'EKCH', 'LSZH', 'LYBE',
  'LTBA', 'LLBG', 'OKBK', 'OMDB', 'OPKC', 'VABB', 'VOMM', 'VTBD',
  'WSSS', 'WRRR', 'YPDN', 'YBTL', 'YBBN'
];

let added = 0, skipped = 0;

for (const icao of ICAOS) {
  const existing = await prisma.wfVisitedAirport.findFirst({
    where: { icao, year: YEAR }
  });
  if (existing) {
    console.log(`  - ${icao} ${YEAR} already exists, skipping`);
    skipped++;
    continue;
  }
  await prisma.wfVisitedAirport.create({
    data: { icao, year: YEAR, eventName: EVENT_NAME }
  });
  console.log(`  + ${icao} ${YEAR}`);
  added++;
}

console.log(`\nDone. Added ${added}, skipped ${skipped}, total ${ICAOS.length}.`);
await prisma.$disconnect();
