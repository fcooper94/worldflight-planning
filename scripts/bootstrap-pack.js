/**
 * bootstrap-pack.js
 *
 * Ensures all shared static files exist in the Euroscope_Files/WorldFlight/
 * output directory. Copies from the UK EuroScope pack where needed.
 *
 * Usage:
 *   node scripts/bootstrap-pack.js
 *
 * Environment variables:
 *   UK_PACK_DIR  - path to the UK EuroScope pack (default: D:\Documents\Euroscope\UK)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'Euroscope_Files', 'WorldFlight');
const UK_DIR = process.env.UK_PACK_DIR || 'D:\\Documents\\Euroscope\\UK';

// ── File manifest ──────────────────────────────────────────────────────────

const COPY_FILES = [
  {
    dest: 'Data/Settings/Symbology.txt',
    src: 'Data/Settings/Symbology_SMR.txt',
  },
  {
    dest: 'Data/Settings/Symbology_Enroute.txt',
    src: 'Data/Settings/AC/NERC_TopSky_Symbology.txt',
  },
  {
    dest: 'Data/Settings/Tags.txt',
    src: 'Data/Settings/Tags.txt',
  },
  {
    dest: 'Data/Settings/Screen.txt',
    src: 'Data/Settings/Screen.txt',
    transform: (content) =>
      content.replace(/m_ShowTsVccsMiniControl:1/g, 'm_ShowTsVccsMiniControl:0'),
  },
  {
    dest: 'Data/Settings/Screen_SMR.txt',
    src: 'Data/Settings/Screen_SMR.txt',
    transform: (content) =>
      content.replace(/m_ShowTsVccsMiniControl:1/g, 'm_ShowTsVccsMiniControl:0'),
  },
  {
    dest: 'Data/Settings/General.txt',
    src: 'Data/Settings/General_SMR.txt',
  },
  {
    dest: 'Data/Datafiles/ICAO_Airlines.txt',
    src: 'Data/Datafiles/ICAO_Airlines.txt',
  },
  {
    dest: 'Data/Datafiles/ICAO_Airports.txt',
    src: 'Data/Datafiles/ICAO_Airports.txt',
  },
  {
    dest: 'Data/Datafiles/ICAO_Aircraft.txt',
    src: 'Data/Datafiles/ICAO_Aircraft.txt',
  },
  {
    dest: 'Data/Datafiles/icao.txt',
    src: 'Data/Datafiles/icao.txt',
  },
  {
    dest: 'Data/Plugin/vSMR/vSMR.dll',
    src: 'Data/Plugin/vSMR/vSMR.dll',
  },
  {
    dest: 'Data/Plugin/vSMR/ICAO_Airlines.txt',
    src: 'Data/Plugin/vSMR/ICAO_Airlines.txt',
  },
  {
    dest: 'Data/Plugin/vSMR/aircraft-data.csv',
    src: 'Data/Plugin/vSMR/aircraft-data.csv',
  },
  {
    dest: 'Data/Plugin/TopSky/TopSky.dll',
    src: 'Data/Plugin/TopSky_NERC/TopSky.dll',
  },
];

// Files generated with inline content (not from UK pack)
const GENERATED_FILES = [
  {
    dest: 'Data/Settings/Lists.txt',
    content: `SIL\r\nm_Visible:0\r\nm_X:0\r\nm_Y:45\r\nm_LineNumber:0\r\nm_Resizable:1\r\nm_OrderingColumn:7\r\nm_HeaderOnly:0\r\nm_Column:C/S:7:0:9:8:1:1::::3:0.0\r\nm_Column:RT:2:0:80:32:0:1::::0:0.0\r\nm_Column:A/C:8:0:115:7:7:1::::3:0.0\r\nm_Column:FR:2:1:63:7:7:1::::3:0.0\r\nm_Column:SSR:5:1:2:31:31:1::::3:0.0\r\nm_Column:ASSR:5:1:60:0:0:1::::0:0.0\r\nm_Column:SPad:10:1:19:29:29:1::::4:0.0\r\nm_Column:RWY:3:1:47:19:19:1::::4:0.0\r\nm_Column:SID:10:0:56:17:17:1::::4:0.0\r\nm_Column:STAR:8:0:55:18:18:1::::4:0.0\r\nm_Column:ADEP:4:1:61:7:7:1::::3:0.0\r\nm_Column:ADES:4:1:17:7:7:1::::3:0.0\r\nm_Column:COPN:7:1:48:21:21:1::::1:0.0\r\nm_Column:NFL:7:1:49:23:23:1::::1:0.0\r\nm_Column:At:5:1:50:0:0:0::::3:0.0\r\nm_Column:X:7:1:51:22:22:0::::1:0.0\r\nm_Column:XFL:7:1:52:24:24:0::::1:0.0\r\nm_Column:SI:3:1:64:20:20:1::::1:0.0\r\nEND\r\nSEL\r\nm_Visible:0\r\nm_X:0\r\nm_Y:76\r\nm_LineNumber:0\r\nm_Resizable:1\r\nm_OrderingColumn:6\r\nm_HeaderOnly:0\r\nm_Column:C/S:7:0:9:8:1:1::::3:0.0\r\nm_Column:RT:2:0:80:32:0:1::::4:0.0\r\nm_Column:A/C:8:0:115:7:7:1::::3:0.0\r\nm_Column:FR:2:1:63:7:7:1::::3:0.0\r\nm_Column:SSR:5:1:2:31:31:1::::3:0.0\r\nm_Column:ASSR:5:1:60:0:0:1::::0:0.0\r\nm_Column:SPad:10:1:19:29:29:1::::4:0.0\r\nm_Column:RWY:3:1:47:19:19:1::::4:0.0\r\nm_Column:SID:10:0:56:17:17:1::::4:0.0\r\nm_Column:STAR:8:0:55:18:18:1::::4:0.0\r\nm_Column:ADEP:4:1:61:7:7:1::::3:0.0\r\nm_Column:ADES:4:1:17:7:7:1::::3:0.0\r\nm_Column:ETA:4:1:54:0:0:0::::3:0.0\r\nm_Column:COPX:7:1:51:22:22:1::::1:0.0\r\nm_Column:XFL:7:1:52:24:24:1::::1:0.0\r\nm_Column:At:5:1:53:0:0:0::::3:0.0\r\nm_Column:RFL:4:1:22:30:30:1::::3:0.0\r\nm_Column:SI:5:1:64:20:20:1::::1:0.0\r\nm_Column:Alt:3:1:43:11:11:0::::4:0.0\r\nm_Column:HDG:5:1:46:14:29:0::::4:0.0\r\nm_Column:Spd:3:1:44:12:29:0::::4:0.0\r\nEND\r\nDEP\r\nm_Visible:1\r\nm_X:521\r\nm_Y:44\r\nm_LineNumber:10\r\nm_Resizable:1\r\nm_OrderingColumn:4\r\nm_HeaderOnly:0\r\nm_Column:STS:4:1:59:46:28:1::::4:0.0\r\nm_Column:C/S:8:0:9:0:1:1::::3:0.0\r\nm_Column:RT:2:0:80:32:0:1::::4:0.0\r\nm_Column:ADEP:4:1:61:0:0:1::::3:0.0\r\nm_Column:A/C:8:1:115:7:7:1::::3:0.0\r\nm_Column:SPad:10:1:19:29:29:1::::4:0.0\r\nm_Column:R:2:1:63:7:7:1::::3:0.0\r\nm_Column:RFL:4:1:22:30:30:1::::3:0.0\r\nm_Column:ADES:4:1:17:7:7:1::::3:0.0\r\nm_Column:SID:10:0:56:17:17:1::::4:0.0\r\nm_Column:RWY:3:1:47:19:19:1::::4:0.0\r\nm_Column:ALT:4:1:20:11:0:1::::4:0.0\r\nm_Column:ASSR:5:1:60:0:0:1::::0:0.0\r\nm_Column:C:1:1:58:27:0:1::::4:0.0\r\nEND\r\nARR\r\nm_Visible:1\r\nm_X:164\r\nm_Y:698\r\nm_LineNumber:6\r\nm_Resizable:0\r\nm_OrderingColumn:1\r\nm_HeaderOnly:0\r\nm_Column:C/S:7:0:9:8:1:1::::3:0.0\r\nm_Column:RT:2:0:80:32:0:1::::4:0.0\r\nm_Column:A/C:8:1:115:0:0:1::::3:0.0\r\nm_Column:STS:4:1:59:46:28:1::::3:0.0\r\nm_Column:SPad:10:1:19:29:29:1::::4:0.0\r\nm_Column:STAR:8:0:55:18:18:1::::4:0.0\r\nm_Column:RWY:3:1:47:19:19:1::::4:0.0\r\nm_Column:Alt:3:1:43:11:11:0::::4:0.0\r\nm_Column:GS:3:1:40:0:0:0::::3:0.0\r\nm_Column:ADEP:5:1:61:0:0:1::::3:0.0\r\nEND\r\nFP\r\nm_Visible:0\r\nm_X:1761\r\nm_Y:724\r\nm_LineNumber:20\r\nm_Resizable:1\r\nm_OrderingColumn:1\r\nm_HeaderOnly:0\r\nm_Column:C/S:7:0:9:8:1:1::::0:0.0\r\nm_Column:ADEP:4:1:61:0:0:1::::3:0.0\r\nm_Column:ADES:5:1:17:7:7:1::::3:0.0\r\nm_Column:A/C:8:1:115:0:0:1::::3:0.0\r\nm_Column:RFL:4:1:22:30:30:1::::3:0.0\r\nm_Column:Route:7:1:23:0:0:1::::0:0.0\r\nEND\r\nCONFLICT\r\nm_Visible:0\r\nm_X:0\r\nm_Y:600\r\nm_LineNumber:6\r\nm_Resizable:0\r\nm_OrderingColumn:1\r\nm_HeaderOnly:0\r\nm_Column:TYPE:6:1:88:0:36:1::::1:0.0\r\nm_Column:C/S:7:0:9:0:36:1::::0:0.0\r\nm_Column:C/S:7:0:85:0:36:1::::1:0.0\r\nm_Column:START:6:1:86:0:36:1::::1:0.0\r\nm_Column:END:6:1:87:0:36:1::::1:0.0\r\nEND\r\nSTUP\r\nm_Visible:0\r\nm_X:0\r\nm_Y:44\r\nm_LineNumber:0\r\nm_Resizable:1\r\nm_OrderingColumn:3\r\nm_HeaderOnly:0\r\nm_Column:STS:4:1:59:46:28:1::::4:0.0\r\nm_Column:C/S:8:0:9:0:1:1::::3:0.0\r\nm_Column:RT:2:0:80:32:0:1::::4:0.0\r\nm_Column:ADEP:4:1:61:0:0:0::::3:0.0\r\nm_Column:A/C:8:1:115:7:7:1::::3:0.0\r\nm_Column:SPad:10:1:19:29:29:1::::4:0.0\r\nm_Column:R:2:1:63:7:7:1::::3:0.0\r\nm_Column:RFL:4:1:22:30:30:1::::3:0.0\r\nm_Column:ADES:4:1:17:7:7:1::::3:0.0\r\nm_Column:SID:10:0:56:17:17:1::::4:0.0\r\nm_Column:RWY:3:1:47:19:19:1::::4:0.0\r\nm_Column:Alt:4:1:20:11:0:1::::4:0.0\r\nm_Column:ASSR:5:1:60:0:0:1::::0:0.0\r\nm_Column:C:1:1:58:27:0:1::::4:0.0\r\nEND\r\nTAXIOUT\r\nm_Visible:0\r\nm_X:0\r\nm_Y:177\r\nm_LineNumber:0\r\nm_Resizable:1\r\nm_OrderingColumn:1\r\nm_HeaderOnly:0\r\nm_Column:STS:4:1:59:46:28:1::::4:0.0\r\nm_Column:C/S:8:0:9:0:1:1::::3:0.0\r\nm_Column:RT:2:0:80:32:32:1::::4:0.0\r\nm_Column:A/C:8:1:115:7:7:1::::3:0.0\r\nm_Column:SPad:10:1:19:29:29:1::::4:0.0\r\nm_Column:R:2:1:63:7:7:1::::3:0.0\r\nm_Column:ADES:4:1:17:7:7:1::::3:0.0\r\nm_Column:SID:10:0:56:17:17:1::::4:0.0\r\nm_Column:RWY:3:1:47:19:19:0::::4:0.0\r\nm_Column:ASSR:5:1:60:0:0:0::::0:0.0\r\nEND\r\nTAKEOFF\r\nm_Visible:0\r\nm_X:0\r\nm_Y:273\r\nm_LineNumber:4\r\nm_Resizable:0\r\nm_OrderingColumn:1\r\nm_HeaderOnly:0\r\nm_Column:DSQ:3:1:57:0:0:0::::3:0.0\r\nm_Column:STS:4:1:59:46:28:1::::4:0.0\r\nm_Column:C/S:8:0:9:8:0:1::::3:0.0\r\nm_Column:RT:2:0:80:32:0:1::::0:0.0\r\nm_Column:A/C:8:1:115:7:7:1::::1:0.0\r\nm_Column:SPad:10:1:19:29:29:1::::4:0.0\r\nm_Column:R:2:1:63:7:7:1::::3:0.0\r\nm_Column:ADES:4:1:17:7:7:1::::3:0.0\r\nm_Column:SID:10:0:56:17:17:1::::4:0.0\r\nm_Column:RWY:3:1:47:19:19:0::::4:0.0\r\nm_Column:CFL:4:1:20:11:0:0::::4:0.0\r\nEND\r\nTAXIIN\r\nm_Visible:0\r\nm_X:120\r\nm_Y:100\r\nm_LineNumber:6\r\nm_Resizable:0\r\nm_OrderingColumn:1\r\nm_HeaderOnly:0\r\nm_Column:CALLSIGN:9:0:9:8:0:1::::0:0.0\r\nm_Column:STN:4:1:19:29:0:1::::1:0.0\r\nm_Column:ATYP:4:1:16:0:0:1::::1:0.0\r\nm_Column:STS:4:1:59:46:28:1::::1:0.0\r\nEND\r\n`,
  },
];

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log('=== WorldFlight Bootstrap: Shared Static Files ===\n');
  console.log(`Output dir : ${OUTPUT_DIR}`);
  console.log(`UK pack dir: ${UK_DIR}\n`);

  const ukAvailable = fs.existsSync(UK_DIR);
  if (!ukAvailable) {
    console.warn(`WARNING: UK pack directory not found at ${UK_DIR}`);
    console.warn('Set UK_PACK_DIR environment variable to the correct path.\n');
  }

  const skipped = [];
  const copied = [];
  const failed = [];

  // Process copy-from-UK files
  for (const entry of COPY_FILES) {
    const destPath = path.join(OUTPUT_DIR, ...entry.dest.split('/'));

    if (fs.existsSync(destPath)) {
      skipped.push(entry.dest);
      continue;
    }

    if (!ukAvailable) {
      failed.push({ file: entry.dest, reason: 'UK pack not found' });
      continue;
    }

    const srcPath = path.join(UK_DIR, ...entry.src.split('/'));
    if (!fs.existsSync(srcPath)) {
      failed.push({ file: entry.dest, reason: `Source not found: ${srcPath}` });
      continue;
    }

    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    if (entry.transform) {
      const content = fs.readFileSync(srcPath, 'utf-8');
      fs.writeFileSync(destPath, entry.transform(content), 'utf-8');
      console.log(`  COPY+TRANSFORM ${entry.src} -> ${entry.dest}`);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  COPY ${entry.src} -> ${entry.dest}`);
    }

    copied.push(entry.dest);
  }

  // Process inline-generated files
  for (const entry of GENERATED_FILES) {
    const destPath = path.join(OUTPUT_DIR, ...entry.dest.split('/'));
    if (fs.existsSync(destPath)) {
      skipped.push(entry.dest);
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.content, 'utf-8');
    console.log(`  GENERATE ${entry.dest}`);
    copied.push(entry.dest);
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`  Already present : ${skipped.length}`);
  console.log(`  Copied          : ${copied.length}`);
  console.log(`  Failed/missing  : ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFiles that could not be resolved:');
    for (const f of failed) {
      console.log(`  - ${f.file}: ${f.reason}`);
    }
  }

  if (failed.length > 0) {
    process.exit(1);
  }

  console.log('\nAll shared static files are present.');
}

main();
