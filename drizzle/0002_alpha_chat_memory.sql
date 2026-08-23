CREATE TABLE `chats` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `rolling_summary` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `pinned` integer DEFAULT false NOT NULL,
  `message_count` integer DEFAULT 0 NOT NULL,
  `last_preview` text DEFAULT '' NOT NULL,
  `summarized_message_count` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chats_updated_at` ON `chats` (`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_chats_status_pinned` ON `chats` (`status`,`pinned`);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `role` text NOT NULL,
  `content` text NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `prompt_tokens` integer DEFAULT 0 NOT NULL,
  `response_tokens` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_chat_sequence` ON `chat_messages` (`chat_id`,`sequence`);
--> statement-breakpoint
CREATE TABLE `message_feedback` (
  `id` text PRIMARY KEY NOT NULL,
  `message_id` text NOT NULL,
  `rating` integer NOT NULL,
  `correction` text DEFAULT '' NOT NULL,
  `remember_correction` integer DEFAULT false NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_feedback_message` ON `message_feedback` (`message_id`);
--> statement-breakpoint
ALTER TABLE `memories` ADD `category` text DEFAULT 'general' NOT NULL;
--> statement-breakpoint
ALTER TABLE `memories` ADD `source_chat_id` text;
--> statement-breakpoint
ALTER TABLE `memories` ADD `confidence` integer DEFAULT 80 NOT NULL;
--> statement-breakpoint
ALTER TABLE `memories` ADD `pinned` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `memories` ADD `last_used_at` integer;
--> statement-breakpoint
ALTER TABLE `memories` ADD `updated_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_memories_pinned` ON `memories` (`pinned`);
