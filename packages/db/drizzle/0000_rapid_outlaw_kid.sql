CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`agent_id` text,
	`action` text NOT NULL,
	`details` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_log_family_ts_idx` ON `activity_log` (`family_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`member_id` text NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`soul_content` text,
	`budget_monthly_cents` integer DEFAULT 0 NOT NULL,
	`spent_monthly_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agents_family_idx` ON `agents` (`family_id`);--> statement-breakpoint
CREATE TABLE `budget_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`balance_after_cents` integer NOT NULL,
	`event_type` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `constitution_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`constitution_id` text NOT NULL,
	`family_id` text NOT NULL,
	`category` text NOT NULL,
	`rule_text` text NOT NULL,
	`enforcement_level` text NOT NULL,
	`evaluation_type` text NOT NULL,
	`evaluation_config` text,
	`applies_to_roles` text,
	`applies_to_min_age` integer,
	`applies_to_max_age` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`constitution_id`) REFERENCES `constitutions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `constitution_rules_constitution_idx` ON `constitution_rules` (`constitution_id`);--> statement-breakpoint
CREATE TABLE `constitutions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`channel` text NOT NULL,
	`started_at` text NOT NULL,
	`last_message_at` text,
	`session_context` text,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversations_agent_idx` ON `conversations` (`agent_id`);--> statement-breakpoint
CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `family_members` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`age` integer NOT NULL,
	`telegram_user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `family_members_telegram_user_id_unique` ON `family_members` (`telegram_user_id`);--> statement-breakpoint
CREATE INDEX `family_members_family_idx` ON `family_members` (`family_id`);--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instance_settings_key_unique` ON `instance_settings` (`key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`token_count` integer,
	`cost_cents` integer,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_ts_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `onboarding_state` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`step` integer NOT NULL,
	`answers` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policy_events` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text,
	`rule_id` text,
	`event_type` text NOT NULL,
	`context` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_id`) REFERENCES `constitution_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policy_events_family_ts_idx` ON `policy_events` (`family_id`,`created_at`);