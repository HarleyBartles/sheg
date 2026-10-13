CREATE TABLE `provider_settings` (
  `singleton_id` integer NOT NULL,
  `revision` integer NOT NULL,
  `catalogue_json` text NOT NULL,
  `preferences_json` text NOT NULL,
  CONSTRAINT `provider_settings_pk` PRIMARY KEY(`singleton_id`),
  CONSTRAINT `provider_settings_singleton_ck` CHECK (`singleton_id` = 1),
  CONSTRAINT `provider_settings_revision_ck` CHECK (`revision` >= 0)
);
--> statement-breakpoint
INSERT INTO `provider_settings` (`singleton_id`, `revision`, `catalogue_json`, `preferences_json`) VALUES (1, 0, '{"revision":0,"entries":[]}', '{"preferredOrder":[]}');