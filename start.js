import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';
import { existsSync, copyFileSync, readFileSync } from 'fs';

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Check current mode
const envContent = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const currentMode = envContent.includes('DEV_MODE=true') ? 'offline' : 'production';

console.log('');
console.log('  WorldFlight Planning Portal');
console.log('  ──────────────────────────');
console.log('');
console.log('  1) Production (Online)  — Railway DB + VATSIM SSO');
console.log('  2) Offline (Dev)        — Local SQLite + Dev Login');
console.log('');
console.log(`  Current: ${currentMode === 'offline' ? 'Offline' : 'Production'}`);
console.log('');

rl.question('  Select mode [1/2]: ', (answer) => {
  rl.close();
  const choice = answer.trim();

  if (choice === '2') {
    switchToDev();
  } else {
    switchToProd();
  }
});

function switchToDev() {
  console.log('');
  console.log('  Switching to Offline (Dev) mode...');

  // Backup production files if not already backed up
  if (existsSync('.env') && !existsSync('.env.prod.bak') && !envContent.includes('DEV_MODE=true')) {
    copyFileSync('.env', '.env.prod.bak');
    console.log('  Backed up .env → .env.prod.bak');
  }
  if (existsSync('prisma/schema.prisma') && !existsSync('prisma/schema.prisma.bak')) {
    copyFileSync('prisma/schema.prisma', 'prisma/schema.prisma.bak');
    console.log('  Backed up schema → prisma/schema.prisma.bak');
  }

  if (!existsSync('.env.dev')) {
    console.error('  ERROR: .env.dev not found');
    process.exit(1);
  }
  if (!existsSync('prisma/schema.dev.prisma')) {
    console.error('  ERROR: prisma/schema.dev.prisma not found');
    process.exit(1);
  }

  copyFileSync('.env.dev', '.env');
  copyFileSync('prisma/schema.dev.prisma', 'prisma/schema.prisma');

  console.log('  Generating Prisma client...');
  execSync('npx prisma generate', { stdio: 'inherit' });
  console.log('  Pushing schema to SQLite...');
  execSync('npx prisma db push', { stdio: 'inherit' });

  console.log('');
  console.log('  Offline mode ready. Login auto-bypasses VATSIM.');
  console.log('');
  startServer();
}

function switchToProd() {
  console.log('');
  console.log('  Switching to Production mode...');

  if (existsSync('.env.prod.bak')) {
    copyFileSync('.env.prod.bak', '.env');
    console.log('  Restored .env from backup');
  } else if (envContent.includes('DEV_MODE=true')) {
    console.error('  ERROR: No .env.prod.bak found. Restore your .env manually.');
    process.exit(1);
  }

  if (existsSync('prisma/schema.prisma.bak')) {
    copyFileSync('prisma/schema.prisma.bak', 'prisma/schema.prisma');
    console.log('  Restored schema from backup');
  }

  console.log('  Generating Prisma client...');
  execSync('npx prisma generate', { stdio: 'inherit' });

  console.log('');
  startServer();
}

function startServer() {
  const child = spawn('npx', ['nodemon', 'index.js'], {
    stdio: 'inherit',
    shell: true
  });

  child.on('exit', (code) => process.exit(code));
}
