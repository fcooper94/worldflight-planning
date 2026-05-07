import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const YEAR = 2012;
const EVENT_NAME = 'WorldFlight';

// Route order from the WorldFlight 2012 official route map (legs 1201-1245).
// Sydney appears at start and end; included once.
const ICAOS = [
  'YSSY', 'NZAA', 'NSFA', 'PHKO', 'MMTJ', 'MMMX', 'MUHA', 'MDSD',
  'TNCM', 'TTPP', 'GVAC', 'GCFV', 'GMMN', 'DAAG', 'LEMD', 'EGBB',
  'ENGM', 'EFHK', 'EPWA', 'EDDF', 'LATI', 'LUKK', 'LTAC', 'OSDI',
  'OIII', 'UTTT', 'OPLA', 'VANP', 'VNKT', 'VGEG', 'ZUUU', 'ZLLL',
  'ZMUB', 'UEEE', 'UHPP', 'UHWW', 'ZBAA', 'RKSS', 'RJOO', 'RCTP',
  'PGSN', 'WABB', 'AYPY', 'YBCS', 'YBBN'
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
