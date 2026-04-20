-- AlterTable: replace teamId (Int) with teamName (Text)
ALTER TABLE "UserAdditionalRole" DROP COLUMN IF EXISTS "teamId";
ALTER TABLE "UserAdditionalRole" ADD COLUMN "teamName" TEXT;
