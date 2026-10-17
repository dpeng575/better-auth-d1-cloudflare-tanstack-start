CREATE TABLE `credit_balances` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_ledger_idempotency_key_unique` ON `credit_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ledger_user_idx` ON `credit_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `video_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_code` text NOT NULL,
	`model_code` text NOT NULL,
	`prompt` text NOT NULL,
	`params_json` text,
	`provider_task_id` text,
	`credits_reserved` integer NOT NULL,
	`error_code` text,
	`error_message` text,
	`result_r2_key` text,
	`result_meta_json` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_tasks_idempotency_key_unique` ON `video_tasks` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `task_user_idx` ON `video_tasks` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_status_idx` ON `video_tasks` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `provider_models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`credit_cost` integer NOT NULL,
	`max_duration_sec` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`params_schema_json` text,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `model_provider_idx` ON `provider_models` (`provider_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`config_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_code_unique` ON `providers` (`code`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`order_no` text NOT NULL,
	`plan_code` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payment_provider` text DEFAULT 'waffo' NOT NULL,
	`payment_ref` text,
	`credits_granted` integer,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_no_unique` ON `orders` (`order_no`);--> statement-breakpoint
CREATE INDEX `order_user_idx` ON `orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan_code` text NOT NULL,
	`status` text NOT NULL,
	`current_period_start` integer NOT NULL,
	`current_period_end` integer NOT NULL,
	`order_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
