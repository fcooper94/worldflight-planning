-- CreateEnum
CREATE TYPE "Simulator" AS ENUM ('MSFS', 'XPLANE', 'P3D');

-- CreateEnum
CREATE TYPE "SceneryType" AS ENUM ('Freeware', 'Payware');

-- CreateTable
CREATE TABLE "OfficialTeam" (
    "id" SERIAL NOT NULL,
    "teamName" TEXT NOT NULL,
    "callsign" TEXT NOT NULL,
    "mainCid" INTEGER NOT NULL,
    "aircraftType" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "participatingWf26" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfficialTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Affiliate" (
    "id" SERIAL NOT NULL,
    "callsign" TEXT NOT NULL,
    "simType" TEXT NOT NULL,
    "cid" INTEGER NOT NULL,
    "participatingWf26" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Affiliate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepFlow" (
    "id" SERIAL NOT NULL,
    "sector" TEXT NOT NULL,
    "rate" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TobtBooking" (
    "id" SERIAL NOT NULL,
    "slotKey" TEXT NOT NULL,
    "cid" INTEGER,
    "callsign" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "dateUtc" TEXT NOT NULL,
    "depTimeUtc" TEXT NOT NULL,
    "tobtTimeUtc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TobtBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "cid" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("cid")
);

-- CreateTable
CREATE TABLE "Airport" (
    "icao" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "elev" INTEGER,

    CONSTRAINT "Airport_pkey" PRIMARY KEY ("icao")
);

-- CreateTable
CREATE TABLE "Runway" (
    "id" SERIAL NOT NULL,
    "airportIcao" TEXT NOT NULL,
    "ident1" TEXT NOT NULL,
    "ident2" TEXT NOT NULL,
    "lat1" DOUBLE PRECISION NOT NULL,
    "lon1" DOUBLE PRECISION NOT NULL,
    "lat2" DOUBLE PRECISION NOT NULL,
    "lon2" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Runway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirportScenery" (
    "id" SERIAL NOT NULL,
    "icao" TEXT NOT NULL,
    "sim" "Simulator" NOT NULL,
    "name" TEXT NOT NULL,
    "developer" TEXT,
    "store" TEXT,
    "url" TEXT NOT NULL,
    "type" "SceneryType" NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "AirportScenery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentationPermission" (
    "id" SERIAL NOT NULL,
    "cid" INTEGER NOT NULL,
    "pattern" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentationPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepFlow_sector_key" ON "DepFlow"("sector");

-- CreateIndex
CREATE UNIQUE INDEX "TobtBooking_slotKey_key" ON "TobtBooking"("slotKey");

-- CreateIndex
CREATE INDEX "AirportScenery_icao_idx" ON "AirportScenery"("icao");

-- CreateIndex
CREATE INDEX "AirportScenery_approved_idx" ON "AirportScenery"("approved");

-- CreateIndex
CREATE INDEX "DocumentationPermission_cid_idx" ON "DocumentationPermission"("cid");

-- AddForeignKey
ALTER TABLE "Runway" ADD CONSTRAINT "Runway_airportIcao_fkey" FOREIGN KEY ("airportIcao") REFERENCES "Airport"("icao") ON DELETE RESTRICT ON UPDATE CASCADE;
