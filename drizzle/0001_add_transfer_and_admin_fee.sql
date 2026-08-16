ALTER TABLE `transactions` ADD COLUMN `admin_fee` real DEFAULT 0.0 NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD COLUMN `target_wallet_id` text REFERENCES wallets(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `transactions_target_wallet_id_idx` ON `transactions` (`target_wallet_id`);
