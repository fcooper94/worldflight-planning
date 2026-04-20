-- CreateTable
CREATE TABLE "UserAdditionalRole" (
    "id" SERIAL NOT NULL,
    "cid" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "teamId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAdditionalRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAdditionalRole_cid_role_key" ON "UserAdditionalRole"("cid", "role");

-- CreateIndex
CREATE INDEX "UserAdditionalRole_cid_idx" ON "UserAdditionalRole"("cid");
