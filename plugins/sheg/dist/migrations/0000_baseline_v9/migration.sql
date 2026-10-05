CREATE TABLE `attempt_evaluations` (
	`run_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`failure_json` text,
	CONSTRAINT `attempt_evaluations_pk` PRIMARY KEY(`run_id`, `attempt_id`, `evaluation_id`),
	CONSTRAINT `attempt_evaluations_attempt_fk` FOREIGN KEY (`run_id`,`attempt_id`) REFERENCES `attempts`(`run_id`,`attempt_id`) ON DELETE CASCADE,
	CONSTRAINT `attempt_evaluations_evaluation_fk` FOREIGN KEY (`run_id`,`evaluation_id`) REFERENCES `evaluations`(`run_id`,`evaluation_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`attempt_sequence` integer PRIMARY KEY AUTOINCREMENT,
	`attempt_id` text NOT NULL CONSTRAINT `attempts_attempt_id_uq` UNIQUE,
	`run_id` text NOT NULL,
	`group_id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`packet_fingerprint` text NOT NULL,
	`owner_token` text NOT NULL,
	`status` text NOT NULL,
	`started_ms` integer NOT NULL,
	`settled_ms` integer,
	`charged_calls` integer DEFAULT 0 NOT NULL,
	`result_json` text,
	`execution_json` text,
	`failure_code` text,
	`failure_message` text,
	`failure_scope` text,
	CONSTRAINT `attempts_run_evaluation_group_fk` FOREIGN KEY (`run_id`,`evaluation_id`,`group_id`) REFERENCES `evaluations`(`run_id`,`evaluation_id`,`group_id`) ON DELETE CASCADE,
	CONSTRAINT `attempts_run_group_fk` FOREIGN KEY (`run_id`,`group_id`) REFERENCES `question_groups`(`run_id`,`group_id`) ON DELETE CASCADE,
	CONSTRAINT `attempts_run_attempt_uq` UNIQUE(`run_id`,`attempt_id`),
	CONSTRAINT "attempts_status_ck" CHECK("status" IN ('reserved', 'answered', 'failed', 'uncertain')),
	CONSTRAINT "attempts_call_ledger_ck" CHECK("charged_calls" >= 0 AND ("status" = 'reserved' OR "settled_ms" IS NOT NULL)),
	CONSTRAINT "attempts_settlement_ck" CHECK(("status" = 'answered' AND "execution_json" IS NOT NULL AND "charged_calls" >= 1) OR ("status" = 'failed' AND "failure_code" IS NOT NULL) OR ("status" = 'uncertain' AND "charged_calls" >= 1) OR ("status" = 'reserved' AND "settled_ms" IS NULL AND "charged_calls" = 0)),
	CONSTRAINT "attempts_failure_scope_ck" CHECK("failure_scope" IS NULL OR "failure_scope" IN ('evaluation', 'run'))
);
--> statement-breakpoint
CREATE TABLE `evaluation_answer_attempts` (
	`run_id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	CONSTRAINT `evaluation_answer_attempts_pk` PRIMARY KEY(`run_id`, `evaluation_id`),
	CONSTRAINT `evaluation_answer_attempts_membership_fk` FOREIGN KEY (`run_id`,`attempt_id`,`evaluation_id`) REFERENCES `attempt_evaluations`(`run_id`,`attempt_id`,`evaluation_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `evaluations` (
	`evaluation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`context_id` text NOT NULL,
	`respondent_id` text NOT NULL,
	`question_id` text NOT NULL,
	`group_id` text NOT NULL,
	`turn_id` text,
	`node_id` text,
	`path_id` text,
	`occurrence` integer,
	`packet_json` text NOT NULL,
	`packet_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`failure_code` text,
	`failure_message` text,
	`failure_detail_json` text,
	CONSTRAINT `evaluations_pk` PRIMARY KEY(`evaluation_id`),
	CONSTRAINT `evaluations_run_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON DELETE CASCADE,
	CONSTRAINT `evaluations_group_fk` FOREIGN KEY (`run_id`,`group_id`) REFERENCES `question_groups`(`run_id`,`group_id`) ON DELETE CASCADE,
	CONSTRAINT `evaluations_run_ordinal_uq` UNIQUE(`run_id`,`ordinal`),
	CONSTRAINT `evaluations_run_eval_uq` UNIQUE(`run_id`,`evaluation_id`),
	CONSTRAINT `evaluations_run_eval_group_uq` UNIQUE(`run_id`,`evaluation_id`,`group_id`),
	CONSTRAINT `evaluations_run_turn_uq` UNIQUE(`run_id`,`turn_id`),
	CONSTRAINT `evaluations_run_respondent_node_occurrence_uq` UNIQUE(`run_id`,`respondent_id`,`node_id`,`occurrence`),
	CONSTRAINT "evaluations_status_ck" CHECK("status" IN ('pending', 'answered', 'failed', 'unreached')),
	CONSTRAINT "evaluations_ordinal_ck" CHECK("ordinal" >= 0),
	CONSTRAINT "evaluations_journey_identity_ck" CHECK(("turn_id" IS NULL AND "node_id" IS NULL AND "path_id" IS NULL AND "occurrence" IS NULL) OR ("turn_id" IS NOT NULL AND "node_id" IS NOT NULL AND "path_id" IS NOT NULL AND "occurrence" >= 1)),
	CONSTRAINT "evaluations_answer_ck" CHECK(("status" = 'answered' AND "result_json" IS NOT NULL AND "failure_code" IS NULL) OR ("status" <> 'answered' AND "result_json" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `journey_respondents` (
	`run_id` text NOT NULL,
	`respondent_id` text NOT NULL,
	`status` text NOT NULL,
	`current_node_id` text,
	`current_turn_id` text,
	`current_context_id` text,
	`revision` integer NOT NULL,
	`events_json` text NOT NULL,
	`route_json` text NOT NULL,
	`outcome` text,
	CONSTRAINT `journey_respondents_pk` PRIMARY KEY(`run_id`, `respondent_id`),
	CONSTRAINT `fk_journey_respondents_run_id_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON DELETE CASCADE,
	CONSTRAINT "journey_respondents_status_ck" CHECK("status" IN ('active', 'completed', 'failed', 'unreached')),
	CONSTRAINT "journey_respondents_revision_ck" CHECK("revision" >= 0),
	CONSTRAINT "journey_respondents_checkpoint_ck" CHECK(("status" = 'active' AND "current_node_id" IS NOT NULL AND "current_turn_id" IS NOT NULL AND "current_context_id" IS NOT NULL) OR ("status" <> 'active' AND "current_node_id" IS NULL AND "current_turn_id" IS NULL AND "current_context_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `question_groups` (
	`group_id` text NOT NULL,
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`context_id` text NOT NULL,
	`respondent_id` text NOT NULL,
	`state_json` text NOT NULL,
	`question_ids_json` text NOT NULL,
	CONSTRAINT `question_groups_pk` PRIMARY KEY(`group_id`),
	CONSTRAINT `fk_question_groups_run_id_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON DELETE CASCADE,
	CONSTRAINT `question_groups_run_ordinal_uq` UNIQUE(`run_id`,`ordinal`),
	CONSTRAINT `question_groups_run_group_uq` UNIQUE(`run_id`,`group_id`),
	CONSTRAINT "question_groups_ordinal_ck" CHECK("ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` text NOT NULL,
	`submission_id` text NOT NULL CONSTRAINT `runs_submission_id_uq` UNIQUE,
	`request_fingerprint` text NOT NULL,
	`created_at` text NOT NULL,
	`created_ms` integer NOT NULL,
	`label` text,
	`status` text NOT NULL,
	`request_json` text NOT NULL,
	`evaluation_count` integer NOT NULL,
	`max_calls` integer NOT NULL,
	`used_calls` integer DEFAULT 0 NOT NULL,
	`reserved_calls` integer DEFAULT 0 NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`owner_token` text,
	`owner_pid` integer,
	`lease_expires_ms` integer,
	`failure_scope` text,
	`failure_code` text,
	`failure_message` text,
	CONSTRAINT `runs_pk` PRIMARY KEY(`run_id`),
	CONSTRAINT `runs_run_submission_uq` UNIQUE(`run_id`,`submission_id`),
	CONSTRAINT "runs_status_ck" CHECK("status" IN ('prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "runs_count_ck" CHECK("evaluation_count" > 0 AND "max_calls" > 0 AND "used_calls" >= 0 AND "reserved_calls" >= 0 AND "used_calls" + "reserved_calls" <= "max_calls"),
	CONSTRAINT "runs_owner_ck" CHECK(("status" = 'running' AND "owner_token" IS NOT NULL AND "owner_pid" IS NOT NULL AND "lease_expires_ms" IS NOT NULL) OR ("status" <> 'running' AND "owner_token" IS NULL AND "owner_pid" IS NULL)),
	CONSTRAINT "runs_cancel_ck" CHECK("cancel_requested" IN (0, 1)),
	CONSTRAINT "runs_failure_scope_ck" CHECK("failure_scope" IS NULL OR "failure_scope" IN ('evaluation', 'run'))
);
--> statement-breakpoint
CREATE TABLE `schema_migrations` (
	`version` integer NOT NULL CONSTRAINT `schema_migrations_version_uq` UNIQUE,
	`migration_id` text NOT NULL,
	`checksum` text NOT NULL,
	`applied_at` text NOT NULL,
	CONSTRAINT `schema_migrations_pk` PRIMARY KEY(`migration_id`),
	CONSTRAINT "schema_migrations_version_ck" CHECK("version" > 0)
);
--> statement-breakpoint
CREATE INDEX `attempts_run_sequence` ON `attempts` (`run_id`,`attempt_sequence`);--> statement-breakpoint
CREATE INDEX `attempts_run_status_sequence` ON `attempts` (`run_id`,`status`,`attempt_sequence`);--> statement-breakpoint
CREATE INDEX `evaluations_pending_turn` ON `evaluations` (`run_id`,`status`,`respondent_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `runs_created_identity` ON `runs` (`created_ms`,`run_id`);--> statement-breakpoint
CREATE INDEX `runs_expired_lease` ON `runs` (`lease_expires_ms`,`run_id`);