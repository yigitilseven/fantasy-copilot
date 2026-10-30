CREATE TABLE `league` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`yahoo_league_key` text,
	`name` text NOT NULL,
	`teams` integer NOT NULL,
	`source_draft_id` integer,
	`settings` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `league_free_agents` (
	`league_id` integer NOT NULL,
	`yahoo_id` text NOT NULL,
	`player_id` text,
	`name` text NOT NULL,
	`nba_team` text,
	`positions` text,
	`pct_owned` real,
	`injury_tag` text,
	`stats` text,
	`captured_at` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `league_fa_uq` ON `league_free_agents` (`league_id`,`yahoo_id`);--> statement-breakpoint
CREATE TABLE `league_roster` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` integer NOT NULL,
	`team_slot` integer NOT NULL,
	`player_id` text NOT NULL,
	`lineup_slot` text,
	`status` text DEFAULT 'active' NOT NULL,
	`acquired_at` text NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `league_roster_team_idx` ON `league_roster` (`league_id`,`team_slot`);--> statement-breakpoint
CREATE UNIQUE INDEX `league_roster_player_uq` ON `league_roster` (`league_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `league_state` (
	`league_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `league_state_uq` ON `league_state` (`league_id`,`key`);--> statement-breakpoint
CREATE TABLE `league_team` (
	`league_id` integer NOT NULL,
	`slot` integer NOT NULL,
	`yahoo_name` text NOT NULL,
	`is_user` integer DEFAULT false NOT NULL,
	`yahoo_team_id` text,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `league_team_uq` ON `league_team` (`league_id`,`slot`);--> statement-breakpoint
CREATE TABLE `roster_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` integer NOT NULL,
	`team_slot` integer NOT NULL,
	`captured_at` text NOT NULL,
	`source` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `roster_snapshots_team_idx` ON `roster_snapshots` (`league_id`,`team_slot`,`id`);--> statement-breakpoint
CREATE TABLE `season_briefs` (
	`league_id` integer NOT NULL,
	`day` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_briefs_uq` ON `season_briefs` (`league_id`,`day`);