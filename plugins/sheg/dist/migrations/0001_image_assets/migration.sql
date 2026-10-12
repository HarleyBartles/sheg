CREATE TABLE `image_assets` (
	`asset_id` text NOT NULL,
	`sha256` text NOT NULL CONSTRAINT `image_assets_sha256_uq` UNIQUE,
	`format` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`content` blob NOT NULL,
	CONSTRAINT `image_assets_pk` PRIMARY KEY(`asset_id`),
	CONSTRAINT "image_assets_digest_ck" CHECK("asset_id" = 'sha256:' || "sha256" AND length("sha256") = 64 AND "sha256" NOT GLOB '*[^a-f0-9]*'),
	CONSTRAINT "image_assets_format_ck" CHECK("format" IN ('png', 'jpeg', 'webp')),
	CONSTRAINT "image_assets_dimensions_ck" CHECK("width" > 0 AND "height" > 0 AND "width" * "height" <= 16000000),
	CONSTRAINT "image_assets_content_ck" CHECK("byte_length" > 0 AND "byte_length" <= 16777216 AND length("content") = "byte_length")
);
--> statement-breakpoint
CREATE TABLE `image_derivations` (
	`source_asset_id` text NOT NULL,
	`candidate_asset_id` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`algorithm` text NOT NULL,
	`policy_version` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `image_derivations_pk` PRIMARY KEY(`candidate_asset_id`),
	CONSTRAINT `fk_image_derivations_source_asset_id_image_assets_asset_id_fk` FOREIGN KEY (`source_asset_id`) REFERENCES `image_assets`(`asset_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_image_derivations_candidate_asset_id_image_assets_asset_id_fk` FOREIGN KEY (`candidate_asset_id`) REFERENCES `image_assets`(`asset_id`) ON DELETE RESTRICT,
	CONSTRAINT "image_derivations_assets_ck" CHECK("source_asset_id" <> "candidate_asset_id"),
	CONSTRAINT "image_derivations_dimensions_ck" CHECK("width" > 0 AND "height" > 0),
	CONSTRAINT "image_derivations_policy_ck" CHECK("algorithm" = 'lanczos3' AND "policy_version" = 1)
);
--> statement-breakpoint
CREATE INDEX `image_derivations_source_idx` ON `image_derivations` (`source_asset_id`,`candidate_asset_id`);