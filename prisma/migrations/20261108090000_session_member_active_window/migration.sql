-- Per-member participation window. Late joiners / early leavers were
-- scored with calories computed over the WHOLE session length, which
-- inflated their calorie + EPOC figures. The Trainer App now sends each
-- member's own active seconds (and join/leave instants) with the session
-- end payload; recalculation uses the same figure. Nullable/additive —
-- existing rows stay valid and fall back to reading-derived durations.
ALTER TABLE "session_members"
  ADD COLUMN "joined_at" TIMESTAMP(3),
  ADD COLUMN "left_at" TIMESTAMP(3),
  ADD COLUMN "active_seconds" INTEGER;
