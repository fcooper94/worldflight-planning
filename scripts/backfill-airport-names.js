import { PrismaClient } from '@prisma/client';
import https from 'https';
import fs from 'fs';
import csv from 'csv-parser';

const prisma = new PrismaClient();

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

async function run() {
  const csvPath = 'airports_tmp.csv';

  console.log('Downloading airports.csv from OurAirports...');
  await download('https://davidmegginson.github.io/ourairports-data/airports.csv', csvPath);

  console.log('Parsing CSV...');
  const names = new Map();
  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', row => {
        if (row.ident && row.ident.length === 4 && row.name) {
          names.set(row.ident.toUpperCase(), row.name);
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  console.log(`Parsed ${names.size} airports with names.`);

  // Get only airports that exist in our DB
  const dbAirports = await prisma.airport.findMany({ select: { icao: true } });
  const toUpdate = dbAirports.filter(a => names.has(a.icao));
  console.log(`Updating ${toUpdate.length} airports in batches...`);

  // Batch update using raw SQL for speed
  const BATCH = 500;
  let done = 0;

  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH);

    // Build a single UPDATE ... FROM VALUES statement
    const values = batch
      .map(a => {
        const name = names.get(a.icao).replace(/'/g, "''");
        return `('${a.icao}', '${name}')`;
      })
      .join(',');

    await prisma.$executeRawUnsafe(`
      UPDATE "Airport" AS a
      SET name = v.name
      FROM (VALUES ${values}) AS v(icao, name)
      WHERE a.icao = v.icao
    `);

    done += batch.length;
    console.log(`  ${done} / ${toUpdate.length}`);
  }

  console.log('Done!');

  if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
  await prisma.$disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
