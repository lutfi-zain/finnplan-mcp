DROP TABLE IF EXISTS `transactions`;--> statement-breakpoint
DROP TABLE IF EXISTS `budgets`;--> statement-breakpoint
DROP TABLE IF EXISTS `categories`;--> statement-breakpoint
DROP TABLE IF EXISTS `wallets`;--> statement-breakpoint
DROP TABLE IF EXISTS `users`;--> statement-breakpoint

CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`user_first_name` text NOT NULL,
	`user_last_name` text NOT NULL,
	`user_email` text NOT NULL,
	`user_whatsapp_number` text NOT NULL,
	`user_api_key_hash` text NOT NULL,
	`user_created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`user_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_api_key_hash_idx` ON `users` (`user_api_key_hash`);--> statement-breakpoint

CREATE TABLE `wallets` (
	`wallet_id` text PRIMARY KEY NOT NULL,
	`wallet_user_id` text NOT NULL,
	`wallet_name` text NOT NULL,
	`wallet_institution` text DEFAULT 'General' NOT NULL,
	`wallet_type` text DEFAULT 'bank' NOT NULL,
	`wallet_balance` real DEFAULT 0.0 NOT NULL,
	`wallet_currency` text DEFAULT 'IDR' NOT NULL,
	`wallet_created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`wallet_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wallets_user_id_idx` ON `wallets` (`wallet_user_id`);--> statement-breakpoint
CREATE INDEX `wallets_institution_idx` ON `wallets` (`wallet_institution`);--> statement-breakpoint

CREATE TABLE `categories` (
	`category_id` text PRIMARY KEY NOT NULL,
	`category_user_id` text NOT NULL,
	`category_name` text NOT NULL,
	`category_type` text DEFAULT 'expense' NOT NULL,
	`category_icon` text,
	`category_created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`category_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `categories_user_id_idx` ON `categories` (`category_user_id`);--> statement-breakpoint

CREATE TABLE `budgets` (
	`budget_id` text PRIMARY KEY NOT NULL,
	`budget_user_id` text NOT NULL,
	`budget_name` text NOT NULL,
	`budget_category_id` text,
	`budget_amount` real NOT NULL,
	`budget_period_start` text NOT NULL,
	`budget_period_end` text NOT NULL,
	`budget_created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`budget_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`budget_category_id`) REFERENCES `categories`(`category_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `budgets_user_period_idx` ON `budgets` (`budget_user_id`,`budget_period_start`,`budget_period_end`);--> statement-breakpoint
CREATE INDEX `budgets_category_id_idx` ON `budgets` (`budget_category_id`);--> statement-breakpoint

CREATE TABLE `transactions` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`transaction_user_id` text NOT NULL,
	`transaction_wallet_id` text NOT NULL,
	`transaction_target_wallet_id` text,
	`transaction_category_id` text,
	`transaction_budget_id` text,
	`transaction_amount` real NOT NULL,
	`transaction_admin_fee` real DEFAULT 0.0 NOT NULL,
	`transaction_type` text DEFAULT 'expense' NOT NULL,
	`transaction_description` text,
	`transaction_is_planned` integer DEFAULT 0 NOT NULL,
	`transaction_date` text NOT NULL,
	`transaction_created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`transaction_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_wallet_id`) REFERENCES `wallets`(`wallet_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_target_wallet_id`) REFERENCES `wallets`(`wallet_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transaction_category_id`) REFERENCES `categories`(`category_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transaction_budget_id`) REFERENCES `budgets`(`budget_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `transactions_user_date_idx` ON `transactions` (`transaction_user_id`,`transaction_date`);--> statement-breakpoint
CREATE INDEX `transactions_wallet_id_idx` ON `transactions` (`transaction_wallet_id`);--> statement-breakpoint
CREATE INDEX `transactions_target_wallet_id_idx` ON `transactions` (`transaction_target_wallet_id`);--> statement-breakpoint
CREATE INDEX `transactions_category_id_idx` ON `transactions` (`transaction_category_id`);--> statement-breakpoint
CREATE INDEX `transactions_budget_id_idx` ON `transactions` (`transaction_budget_id`);
