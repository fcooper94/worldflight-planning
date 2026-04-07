#!/bin/bash
# Switch between dev (SQLite, offline) and production (PostgreSQL, VATSIM SSO)
#
# Usage:
#   bash dev-setup.sh        # switch to dev mode
#   bash dev-setup.sh prod   # switch back to production mode
#
# IMPORTANT: Stop the server before running this script.

if [ "$1" = "prod" ]; then
  echo "Switching to PRODUCTION mode..."

  if [ ! -f .env.prod.bak ]; then
    echo "ERROR: No production .env backup found (.env.prod.bak)"
    echo "You may need to restore your .env manually."
    exit 1
  fi

  cp .env.prod.bak .env
  npx prisma generate

  echo ""
  echo "Production mode restored."
  echo "Restart your server."
  exit 0
fi

echo "Switching to DEV mode..."
echo "Make sure the server is stopped!"
echo ""

# Backup production .env (only if not already backed up)
if [ ! -f .env.prod.bak ]; then
  cp .env .env.prod.bak
  echo "Backed up .env to .env.prod.bak"
else
  echo "Production .env backup already exists"
fi

# Switch to dev .env
cp .env.dev .env
echo "Switched .env to dev mode"

# Generate client and create SQLite DB using dev schema (without overwriting schema.prisma)
npx prisma generate --schema=prisma/schema.dev.prisma
npx prisma db push --schema=prisma/schema.dev.prisma

echo ""
echo "Dev mode ready! Start with: node index.js"
echo "Login: click 'Login with VATSIM' — auto-logs in as Dev Admin (no internet needed)"
