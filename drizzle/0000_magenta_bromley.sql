CREATE TABLE `draft_picks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`pick` integer NOT NULL,
	`round` integer NOT NULL,
	`team_slot` integer NOT NULL,
	`player_id` text NOT NULL,
	`source` text NOT NULL,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_picks_draft_pick_uq` ON `draft_picks` (`draft_id`,`pick`);--> statement-breakpoint
CREATE UNIQUE INDEX `draft_picks_draft_player_uq` ON `draft_picks` (`draft_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`teams` integer NOT NULL,
	`user_slot` integer NOT NULL,
	`rounds` integer NOT NULL,
	`current_pick` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `player_market` (
	`player_id` text PRIMARY KEY NOT NULL,
	`yahoo_adp` real NOT NULL,
	`adp_std_dev` real NOT NULL,
	`rank` integer NOT NULL,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `player_projections` (
	`player_id` text PRIMARY KEY NOT NULL,
	`games` real NOT NULL,
	`minutes` real NOT NULL,
	`pts` real NOT NULL,
	`fgm` real NOT NULL,
	`fga` real NOT NULL,
	`ftm` real NOT NULL,
	`fta` real NOT NULL,
	`three_pm` real NOT NULL,
	`reb` real NOT NULL,
	`ast` real NOT NULL,
	`stl` real NOT NULL,
	`blk` real NOT NULL,
	`tov` real NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `player_risk` (
	`player_id` text PRIMARY KEY NOT NULL,
	`projected_games` real NOT NULL,
	`current_status` text NOT NULL,
	`injury_history_score` real NOT NULL,
	`rest_risk` real NOT NULL,
	`availability_score` real NOT NULL,
	`major_injury_history` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`yahoo_player_key` text,
	`name` text NOT NULL,
	`nba_team` text NOT NULL,
	`positions` text NOT NULL,
	`age` real NOT NULL
);
