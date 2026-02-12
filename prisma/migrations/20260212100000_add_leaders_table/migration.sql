-- Create leaders table for Polymarket leaderboard caching
CREATE TABLE IF NOT EXISTS "leaders" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "display_name" TEXT,
    "profile_image_url" TEXT,
    "pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "leaders_address_key" ON "leaders"("address");
CREATE INDEX IF NOT EXISTS "leaders_rank_idx" ON "leaders"("rank");
