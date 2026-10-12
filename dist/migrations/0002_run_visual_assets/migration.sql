CREATE TABLE `run_visual_assets` (
	`run_id` text NOT NULL,
	`material_id` text NOT NULL,
	`asset_id` text NOT NULL,
	CONSTRAINT `run_visual_assets_pk` PRIMARY KEY(`run_id`, `material_id`),
	CONSTRAINT `fk_run_visual_assets_run_id_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_run_visual_assets_asset_id_image_assets_asset_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `image_assets`(`asset_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `run_visual_assets_asset_idx` ON `run_visual_assets` (`asset_id`,`run_id`);