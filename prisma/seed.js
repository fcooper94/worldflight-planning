import fs from 'fs';
import csv from 'csv-parser';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function loadCSV(path) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(path)
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function toFloat(value) {
  return value === '' || value == null ? null : parseFloat(value);
}

function toInt(value) {
  return value === '' || value == null ? null : parseInt(value, 10);
}

async function main() {
  console.log('Loading CSVs…');

  const airports = await loadCSV('airports.csv');
  const runways = await loadCSV('runways.csv');

  console.log(`Seeding ${airports.length} airports…`);

  for (const a of airports) {
    if (!a.ident || a.ident.length !== 4) continue; // ICAO only

    await prisma.airport.upsert({
      where: { icao: a.ident.toUpperCase() },
      update: {},
      create: {
        icao: a.ident.toUpperCase(),
        name: a.name || null,
        lat: toFloat(a.latitude_deg),
        lon: toFloat(a.longitude_deg),
        elev: toInt(a.elevation_ft),
      }
    });
  }

  console.log(`Seeding ${runways.length} runways…`);

  for (const r of runways) {
    if (!r.airport_ident || r.airport_ident.length !== 4) continue;

    await prisma.runway.create({
      data: {
        airportIcao: r.airport_ident.toUpperCase(),
        ident1: r.le_ident || null,
        ident2: r.he_ident || null,
        lat1: toFloat(r.le_latitude_deg),
        lon1: toFloat(r.le_longitude_deg),
        lat2: toFloat(r.he_latitude_deg),
        lon2: toFloat(r.he_longitude_deg),
      }
    });
  }

  console.log('Seeding complete.');
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
