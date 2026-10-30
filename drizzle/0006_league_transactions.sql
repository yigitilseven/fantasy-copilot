CREATE TABLE `league_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` integer NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_on` text,
	`occurred_time` text,
	`actions` text NOT NULL,
	`applied` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `league_txn_date_idx` ON `league_transactions` (`league_id`,`occurred_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `league_txn_uq` ON `league_transactions` (`league_id`,`key`);