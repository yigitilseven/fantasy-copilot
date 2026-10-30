CREATE TABLE `news_source_status` (
	`source` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_attempt_at` text NOT NULL,
	`last_success_at` text,
	`last_error` text,
	`item_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `player_news` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`title` text NOT NULL,
	`link` text NOT NULL,
	`source` text NOT NULL,
	`published_at` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `player_news_player_idx` ON `player_news` (`player_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `player_status_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` text NOT NULL,
	`status` text NOT NULL,
	`injury` text,
	`est_return_date` text,
	`comment` text,
	`source` text NOT NULL,
	`reported_at` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `player_status_updates_player_idx` ON `player_status_updates` (`player_id`,`id`);