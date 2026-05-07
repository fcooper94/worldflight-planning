import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const YEAR = 2011;
const EVENT_NAME = 'WorldFlight';

// Route order from the WorldFlight 2011 official route map (legs 1101-1145).
// Sydney appears at start and end; included once.
const ICAOS = [
  'YSSY', 'YPDN', 'WIII', 'VOBG', 'OMAA', 'OYAA', 'OEMA', 'OLBA',
  'LTBJ', 'LIRF', 'LEZL', 'LPLA', 'GCXO', 'GGOV', 'DGAA', 'SBRF',
  'SBBE', 'SMJP', 'SVMI', 'SKBQ', 'TJBQ', 'MKJP', 'MYNN', 'KJAX',
  'KMEM', 'KICT', 'KPIT', 'KBOS', 'CYYR', 'BIKF', 'EGPK', 'ESGG',
  'EYVI', 'UUOK', 'UBBB', 'UTST', 'OPQT', 'VTCC', 'VMMC', 'VDPP',
  'WARR', 'YCIN', 'YPPH', 'YPAD', 'YMML'
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
