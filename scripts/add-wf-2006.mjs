import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const YEAR = 2006;
const EVENT_NAME = 'WorldFlight';

// Route order from the WorldFlight 2006 itinerary (Sydney to Sydney).
// Sydney appears at start and end; included once.
const ICAOS = [
  'YSSY', 'NFFN', 'PHNL', 'KSAN', 'KRNO', 'KPDX', 'CYYC', 'CYWG',
  'KORD', 'KBNA', 'KMSY', 'MUHA', 'TNCC', 'TXKF', 'LPAZ', 'LPPR',
  'EGKK', 'EGPH', 'ENGM', 'EDDM', 'LYBE', 'LTBA', 'OSDI', 'HEGN',
  'HSPN', 'HDAM', 'HUEN', 'FVHA', 'FADN', 'FMMI', 'FSIA', 'VCBI',
  'VYYY', 'ZPPP', 'ZLLL', 'ZBAA', 'ZKPY', 'RJBB', 'VHHH', 'VVTS',
  'WAMM', 'AYPY', 'YPDN', 'YBAS', 'YBBN'
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
