import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const YEAR = 2009;
const EVENT_NAME = 'WorldFlight';

// Route order from the WorldFlight 2009 official route map.
// Sydney appears at start and end; included once.
const ICAOS = [
  'YSSY', 'YPPH', 'YPLM', 'FJDG', 'VCBI', 'VANP', 'VIDP', 'UAFM',
  'UACC', 'UNBB', 'USSS', 'UWWW', 'UMMS', 'UUWW', 'ULLI', 'EVRA',
  'EPWA', 'LUKK', 'LBSF', 'LOWW', 'EGLF', 'LFRS', 'EIDW', 'LPAZ',
  'GMME', 'TXKF', 'KIAD', 'KDTW', 'KFAR', 'KMCI', 'KGTF', 'CYEG',
  'PANC', 'UHMM', 'UHWW', 'RJOO', 'RODN', 'VHHH', 'RPLB', 'PGUM',
  'AYPY', 'YPDN', 'YBAS', 'YPAD', 'YMML'
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
