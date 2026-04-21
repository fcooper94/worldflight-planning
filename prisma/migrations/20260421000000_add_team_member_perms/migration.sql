-- Team member per-user flags (apply to rows where role = 'WF_TEAM')
ALTER TABLE "UserAdditionalRole" ADD COLUMN "canEditBookings" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "UserAdditionalRole" ADD COLUMN "canManageMembers" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserAdditionalRole" ADD COLUMN "participating" BOOLEAN NOT NULL DEFAULT true;
