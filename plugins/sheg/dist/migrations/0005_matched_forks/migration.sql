PRAGMA foreign_keys = OFF;
--> statement-breakpoint
CREATE TABLE evaluations_new (
  evaluation_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  context_id TEXT NOT NULL,
  respondent_id TEXT NOT NULL,
  branch_id TEXT NOT NULL DEFAULT 'root',
  question_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  turn_id TEXT,
  node_id TEXT,
  path_id TEXT,
  occurrence INTEGER,
  packet_json TEXT NOT NULL,
  packet_fingerprint TEXT NOT NULL,
  provider_selection_json TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  failure_detail_json TEXT,
  CONSTRAINT evaluations_run_fk FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  CONSTRAINT evaluations_group_fk FOREIGN KEY (run_id, group_id) REFERENCES question_groups(run_id, group_id) ON DELETE CASCADE,
  CONSTRAINT evaluations_run_ordinal_uq UNIQUE (run_id, ordinal),
  CONSTRAINT evaluations_run_eval_uq UNIQUE (run_id, evaluation_id),
  CONSTRAINT evaluations_run_eval_group_uq UNIQUE (run_id, evaluation_id, group_id),
  CONSTRAINT evaluations_run_turn_uq UNIQUE (run_id, turn_id),
  CONSTRAINT evaluations_run_respondent_branch_node_occurrence_uq UNIQUE (run_id, respondent_id, branch_id, node_id, occurrence),
  CONSTRAINT evaluations_run_eval_respondent_branch_uq UNIQUE (run_id, evaluation_id, respondent_id, branch_id),
  CONSTRAINT evaluations_status_ck CHECK (status IN ('pending', 'answered', 'failed', 'unreached')),
  CONSTRAINT evaluations_ordinal_ck CHECK (ordinal >= 0),
  CONSTRAINT evaluations_journey_identity_ck CHECK ((turn_id IS NULL AND node_id IS NULL AND path_id IS NULL AND occurrence IS NULL) OR (turn_id IS NOT NULL AND node_id IS NOT NULL AND path_id IS NOT NULL AND occurrence >= 1)),
  CONSTRAINT evaluations_answer_ck CHECK ((status = 'answered' AND result_json IS NOT NULL AND failure_code IS NULL) OR (status <> 'answered' AND result_json IS NULL))
);
--> statement-breakpoint
INSERT INTO evaluations_new (evaluation_id, run_id, ordinal, context_id, respondent_id, branch_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, provider_selection_json, status, result_json, failure_code, failure_message, failure_detail_json)
SELECT evaluation_id, run_id, ordinal, context_id, respondent_id, 'root', question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, provider_selection_json, status, result_json, failure_code, failure_message, failure_detail_json FROM evaluations;
--> statement-breakpoint
DROP TABLE evaluations;
--> statement-breakpoint
ALTER TABLE evaluations_new RENAME TO evaluations;
--> statement-breakpoint
CREATE INDEX evaluations_pending_turn ON evaluations (run_id, status, respondent_id, ordinal);
--> statement-breakpoint
CREATE TABLE journey_respondents_new (
  run_id TEXT NOT NULL,
  respondent_id TEXT NOT NULL,
  branch_id TEXT NOT NULL DEFAULT 'root',
  status TEXT NOT NULL,
  current_node_id TEXT,
  current_turn_id TEXT,
  current_context_id TEXT,
  revision INTEGER NOT NULL,
  events_json TEXT NOT NULL,
  route_json TEXT NOT NULL,
  outcome TEXT,
  CONSTRAINT journey_respondents_pk PRIMARY KEY (run_id, respondent_id, branch_id),
  CONSTRAINT fk_journey_respondents_run_id_runs_run_id_fk FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  CONSTRAINT journey_respondents_status_ck CHECK (status IN ('active', 'waiting-fork', 'branched', 'completed', 'failed', 'unreached')),
  CONSTRAINT journey_respondents_revision_ck CHECK (revision >= 0),
  CONSTRAINT journey_respondents_checkpoint_ck CHECK ((status = 'active' AND current_node_id IS NOT NULL AND current_turn_id IS NOT NULL AND current_context_id IS NOT NULL) OR (status = 'waiting-fork' AND current_node_id IS NOT NULL AND current_turn_id IS NULL AND current_context_id IS NOT NULL) OR (status IN ('branched', 'completed', 'failed', 'unreached') AND current_node_id IS NULL AND current_turn_id IS NULL AND current_context_id IS NULL))
);
--> statement-breakpoint
INSERT INTO journey_respondents_new (run_id, respondent_id, branch_id, status, current_node_id, current_turn_id, current_context_id, revision, events_json, route_json, outcome)
SELECT run_id, respondent_id, 'root', status, current_node_id, current_turn_id, current_context_id, revision, events_json, route_json, outcome FROM journey_respondents;
--> statement-breakpoint
DROP TABLE journey_respondents;
--> statement-breakpoint
ALTER TABLE journey_respondents_new RENAME TO journey_respondents;
--> statement-breakpoint
CREATE TABLE journey_forks (
  run_id TEXT NOT NULL,
  fork_node_id TEXT NOT NULL,
  parent_branch_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cohort_count INTEGER NOT NULL,
  opened_ms INTEGER NOT NULL,
  closed_ms INTEGER,
  revision INTEGER NOT NULL,
  CONSTRAINT journey_forks_pk PRIMARY KEY (run_id, fork_node_id, parent_branch_id),
  CONSTRAINT fk_journey_forks_run_id_runs_run_id_fk FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  CONSTRAINT journey_forks_status_ck CHECK ((status = 'open' AND closed_ms IS NULL) OR (status = 'closed' AND closed_ms >= opened_ms)),
  CONSTRAINT journey_forks_counts_ck CHECK (cohort_count >= 0 AND opened_ms >= 0 AND revision >= 0)
);
--> statement-breakpoint
CREATE TABLE journey_fork_members (
  run_id TEXT NOT NULL,
  fork_node_id TEXT NOT NULL,
  parent_branch_id TEXT NOT NULL,
  respondent_id TEXT NOT NULL,
  condition_ordinal INTEGER NOT NULL,
  condition_id TEXT NOT NULL,
  child_branch_id TEXT NOT NULL,
  source_context_id TEXT NOT NULL,
  child_context_id TEXT NOT NULL,
  child_turn_id TEXT NOT NULL,
  child_evaluation_id TEXT NOT NULL,
  CONSTRAINT journey_fork_members_pk PRIMARY KEY (run_id, fork_node_id, parent_branch_id, respondent_id, condition_id),
  CONSTRAINT journey_fork_members_fork_fk FOREIGN KEY (run_id, fork_node_id, parent_branch_id) REFERENCES journey_forks(run_id, fork_node_id, parent_branch_id) ON DELETE CASCADE,
  CONSTRAINT journey_fork_members_parent_fk FOREIGN KEY (run_id, respondent_id, parent_branch_id) REFERENCES journey_respondents(run_id, respondent_id, branch_id) ON DELETE CASCADE,
  CONSTRAINT journey_fork_members_child_evaluation_fk FOREIGN KEY (run_id, child_evaluation_id, respondent_id, child_branch_id) REFERENCES evaluations(run_id, evaluation_id, respondent_id, branch_id) ON DELETE CASCADE,
  CONSTRAINT journey_fork_members_ordinal_uq UNIQUE (run_id, fork_node_id, parent_branch_id, respondent_id, condition_ordinal),
  CONSTRAINT journey_fork_members_child_branch_uq UNIQUE (run_id, fork_node_id, parent_branch_id, respondent_id, child_branch_id),
  CONSTRAINT journey_fork_members_child_context_uq UNIQUE (run_id, child_context_id),
  CONSTRAINT journey_fork_members_child_turn_uq UNIQUE (run_id, child_turn_id),
  CONSTRAINT journey_fork_members_child_evaluation_uq UNIQUE (run_id, child_evaluation_id),
  CONSTRAINT journey_fork_members_ordinal_ck CHECK (condition_ordinal >= 0)
);
--> statement-breakpoint
PRAGMA foreign_keys = ON;
