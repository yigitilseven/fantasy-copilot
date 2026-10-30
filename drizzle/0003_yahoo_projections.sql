CREATE TABLE `yahoo_projections` (
	`yahoo_id` text PRIMARY KEY NOT NULL,
	`player_id` text,
	`name` text NOT NULL,
	`nba_team` text,
	`positions` text,
	`gp` real,
	`fg_pct` real,
	`ft_pct` real,
	`three_pm` real,
	`pts` real,
	`reb` real,
	`ast` real,
	`stl` real,
	`blk` real,
	`tov` real,
	`xrank` real,
	`rank` real,
	`adp` real,
	`season` text NOT NULL,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `yahoo_projections_player_idx` ON `yahoo_projections` (`player_id`);