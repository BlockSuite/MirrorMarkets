-- Phase 2A: Server Wallets — Custody Reduction
-- Adds ServerWallet table and new enum values for Dynamic Server Wallets.

-- Add new WalletType value
ALTER TYPE "WalletType" ADD VALUE IF NOT EXISTS 'SERVER_WALLET';

-- Add ServerWalletStatus enum
DO $$ BEGIN
  CREATE TYPE "ServerWalletStatus" AS ENUM ('CREATING', 'READY', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add new AuditAction values
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SERVER_WALLET_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SERVER_WALLET_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNING_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNING_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNING_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MIGRATION_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MIGRATION_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MIGRATION_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRIVATE_KEY_DESTROYED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OWNERSHIP_TRANSFERRED';

-- Create server_wallets table
CREATE TABLE IF NOT EXISTS "server_wallets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "dynamic_server_wallet_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "ServerWalletStatus" NOT NULL DEFAULT 'CREATING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "server_wallets_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "server_wallets_user_id_key" ON "server_wallets"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "server_wallets_dynamic_server_wallet_id_key" ON "server_wallets"("dynamic_server_wallet_id");
CREATE INDEX IF NOT EXISTS "server_wallets_address_idx" ON "server_wallets"("address");

-- Foreign key
ALTER TABLE "server_wallets" ADD CONSTRAINT "server_wallets_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Make enc_priv_key nullable on wallets (it was already nullable, but ensure it)
-- No change needed — the column is already String? in the schema.
