-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TobtBooking" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slotKey" TEXT NOT NULL,
    "cid" INTEGER,
    "callsign" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "dateUtc" TEXT NOT NULL,
    "depTimeUtc" TEXT NOT NULL,
    "tobtTimeUtc" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedByAtc" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_TobtBooking" ("callsign", "cid", "createdAt", "dateUtc", "depTimeUtc", "from", "id", "slotKey", "to", "tobtTimeUtc") SELECT "callsign", "cid", "createdAt", "dateUtc", "depTimeUtc", "from", "id", "slotKey", "to", "tobtTimeUtc" FROM "TobtBooking";
DROP TABLE "TobtBooking";
ALTER TABLE "new_TobtBooking" RENAME TO "TobtBooking";
CREATE UNIQUE INDEX "TobtBooking_slotKey_key" ON "TobtBooking"("slotKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
