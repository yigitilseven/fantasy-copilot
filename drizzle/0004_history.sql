CREATE TABLE `draft_meta` (
	`draft_id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`yahoo_room_key` text,
	`league_name` text,
	`finished_at` text,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `draft_pick_context` (
	`draft_id` integer NOT NULL,
	`pick` integer NOT NULL,
	`adp_at_pick` real,
	`our_rank_at_pick` integer,
	`our_state_at_pick` text,
	`available_count` integer,
	`yahoo_id` text,
	`team_name` text,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_pick_context_uq` ON `draft_pick_context` (`draft_id`,`pick`);--> statement-breakpoint
CREATE TABLE `draft_standings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`view` text NOT NULL,
	`team_name` text NOT NULL,
	`rank` real NOT NULL,
	`fg` real,
	`ft` real,
	`three_pm` real,
	`pts` real,
	`reb` real,
	`ast` real,
	`stl` real,
	`blk` real,
	`tov` real,
	`total` real,
	`captured_at` text NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_standings_uq` ON `draft_standings` (`draft_id`,`view`,`team_name`);--> statement-breakpoint
CREATE TABLE `draft_team` (
	`draft_id` integer NOT NULL,
	`team_slot` integer NOT NULL,
	`yahoo_team_name` text NOT NULL,
	`is_user` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_team_uq` ON `draft_team` (`draft_id`,`team_slot`);--> statement-breakpoint
CREATE TABLE `model_params` (
	`name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`fitted_at` text NOT NULL
);
