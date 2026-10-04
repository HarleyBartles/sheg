PRAGMA foreign_keys = ON;
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE, request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL, created_ms INTEGER NOT NULL, label TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted')),
  request_json TEXT NOT NULL, evaluation_count INTEGER NOT NULL CHECK (evaluation_count > 0),
  max_calls INTEGER NOT NULL CHECK (max_calls > 0), used_calls INTEGER NOT NULL DEFAULT 0 CHECK (used_calls >= 0),
  reserved_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0), cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  owner_token TEXT, owner_pid INTEGER, lease_expires_ms INTEGER,
  failure_scope TEXT CHECK (failure_scope IS NULL OR failure_scope IN ('evaluation', 'run')),
  failure_code TEXT, failure_message TEXT, CHECK (used_calls + reserved_calls <= max_calls)
);
CREATE TABLE question_groups (
  group_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, context_id TEXT NOT NULL, respondent_id TEXT NOT NULL,
  state_json TEXT NOT NULL, question_ids_json TEXT NOT NULL, UNIQUE (run_id, ordinal), UNIQUE (run_id, group_id)
);
CREATE TABLE evaluations (
  evaluation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0), context_id TEXT NOT NULL, respondent_id TEXT NOT NULL,
  question_id TEXT NOT NULL, group_id TEXT NOT NULL, turn_id TEXT, node_id TEXT, path_id TEXT, occurrence INTEGER,
  packet_json TEXT NOT NULL, packet_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'failed', 'unreached')),
  result_json TEXT, failure_code TEXT, failure_message TEXT, failure_detail_json TEXT,
  UNIQUE (run_id, ordinal), UNIQUE (run_id, evaluation_id),
  FOREIGN KEY (run_id, group_id) REFERENCES question_groups(run_id, group_id) ON DELETE CASCADE,
  UNIQUE (run_id, turn_id), UNIQUE (run_id, respondent_id, node_id, occurrence),
  CHECK ((turn_id IS NULL AND node_id IS NULL AND path_id IS NULL AND occurrence IS NULL) OR
    (turn_id IS NOT NULL AND node_id IS NOT NULL AND path_id IS NOT NULL AND occurrence IS NOT NULL AND occurrence >= 1))
);
CREATE TABLE journey_respondents (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, respondent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'unreached')),
  current_node_id TEXT, current_turn_id TEXT, current_context_id TEXT, revision INTEGER NOT NULL CHECK (revision >= 0),
  events_json TEXT NOT NULL, route_json TEXT NOT NULL, outcome TEXT, PRIMARY KEY (run_id, respondent_id),
  CHECK ((status = 'active' AND current_node_id IS NOT NULL AND current_turn_id IS NOT NULL AND current_context_id IS NOT NULL) OR
    (status <> 'active' AND current_node_id IS NULL AND current_turn_id IS NULL AND current_context_id IS NULL))
);
CREATE TABLE attempts (
  attempt_sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  group_id TEXT NOT NULL, evaluation_id TEXT NOT NULL, packet_fingerprint TEXT NOT NULL, owner_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'answered', 'failed', 'uncertain')),
  started_ms INTEGER NOT NULL, settled_ms INTEGER, result_json TEXT, execution_json TEXT,
  failure_code TEXT, failure_message TEXT, failure_scope TEXT CHECK (failure_scope IS NULL OR failure_scope IN ('evaluation', 'run')),
  FOREIGN KEY (run_id, evaluation_id) REFERENCES evaluations(run_id, evaluation_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, group_id) REFERENCES question_groups(run_id, group_id) ON DELETE CASCADE
);
CREATE TABLE attempt_evaluations (
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
  failure_json TEXT, PRIMARY KEY (attempt_id, evaluation_id)
);
CREATE TABLE evaluation_answer_attempts (
  evaluation_id TEXT PRIMARY KEY REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  FOREIGN KEY (attempt_id, evaluation_id) REFERENCES attempt_evaluations(attempt_id, evaluation_id) ON DELETE CASCADE
);
CREATE INDEX evaluations_run_ordinal ON evaluations(run_id, ordinal);
CREATE INDEX runs_created_identity ON runs(created_ms, run_id);
PRAGMA user_version = 7;
INSERT INTO runs (run_id, submission_id, request_fingerprint, created_at, created_ms, label, status, request_json, evaluation_count, max_calls, used_calls, reserved_calls)
VALUES ('run-follow-on', 'submission-follow-on', 'request-hash', '2026-10-03T12:00:00.000Z', 1791028800000, 'Migration fixture', 'completed', '{"request":{"kind":"follow-on","context":{"includeSelectedMaterial":true}},"lineage":{"sourceRunId":"run-source","selections":[{"sourceEvaluationId":"evaluation-source","materialId":"quote-1","text":"An exact selected paragraph."}]}}', 1, 3, 1, 0);
INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
VALUES ('group-1', 'run-follow-on', 0, 'context-1', 'reader-1', '{"history":"preserved"}', '["clarity"]');
INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, packet_json, packet_fingerprint, status, result_json)
VALUES ('evaluation-1', 'run-follow-on', 0, 'context-1', 'reader-1', 'clarity', 'group-1', '{"question":{"type":"score","id":"clarity"},"state":{"selectedMaterial":"An exact selected paragraph."}}', 'packet-hash', 'answered', '{"type":"score","score":0.75,"probabilities":{"low":0.1,"high":0.9},"confidence":0.8}');
INSERT INTO attempts (attempt_sequence, attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms, settled_ms, result_json, execution_json)
VALUES (4, 'attempt-1', 'run-follow-on', 'group-1', 'evaluation-1', 'packet-hash', 'owner-1', 'answered', 1791028800001, 1791028800002, '{"type":"score","score":0.75}', '{"provider":"typesafe","model":"jev-latest","physicalAttempts":1}');
INSERT INTO attempt_evaluations (attempt_id, evaluation_id, failure_json) VALUES ('attempt-1', 'evaluation-1', NULL);
INSERT INTO evaluation_answer_attempts (evaluation_id, attempt_id) VALUES ('evaluation-1', 'attempt-1');
INSERT INTO runs (run_id, submission_id, request_fingerprint, created_at, created_ms, label, status, request_json, evaluation_count, max_calls, used_calls, reserved_calls)
VALUES ('run-source', 'submission-source', 'source-request-hash', '2026-10-03T11:00:00.000Z', 1791025200000, 'Source study', 'completed', '{"request":{"kind":"poll"}}', 1, 2, 1, 0);
INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
VALUES ('group-source', 'run-source', 0, 'context-source', 'reader-1', '{"profile":"source-reader"}', '["selection"]');
INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, packet_json, packet_fingerprint, status, result_json)
VALUES ('evaluation-source', 'run-source', 0, 'context-source', 'reader-1', 'selection', 'group-source', '{"question":{"type":"choice","id":"selection"}}', 'source-packet-hash', 'answered', '{"type":"choice","choice":"quote-1","confidence":0.9}');
INSERT INTO attempts (attempt_sequence, attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms, settled_ms, result_json, execution_json)
VALUES (3, 'attempt-source', 'run-source', 'group-source', 'evaluation-source', 'source-packet-hash', 'owner-source', 'answered', 1791025200001, 1791025200002, '{"type":"choice","choice":"quote-1"}', '{"provider":"typesafe","model":"jev-latest","physicalAttempts":1}');
INSERT INTO attempt_evaluations (attempt_id, evaluation_id, failure_json) VALUES ('attempt-source', 'evaluation-source', NULL);
INSERT INTO evaluation_answer_attempts (evaluation_id, attempt_id) VALUES ('evaluation-source', 'attempt-source');
UPDATE runs SET evaluation_count = 3, max_calls = 5, used_calls = 3 WHERE run_id = 'run-follow-on';
UPDATE question_groups SET question_ids_json = '["clarity","choice-check","noul-check"]' WHERE group_id = 'group-1';
INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, packet_json, packet_fingerprint, status, result_json)
VALUES
  ('evaluation-choice', 'run-follow-on', 1, 'context-1', 'reader-1', 'choice-check', 'group-1', '{"question":{"type":"choice","id":"choice-check"}}', 'choice-packet-hash', 'answered', '{"type":"choice","choice":"yes","confidence":0.8}'),
  ('evaluation-noul', 'run-follow-on', 2, 'context-1', 'reader-1', 'noul-check', 'group-1', '{"question":{"type":"noul","id":"noul-check"}}', 'noul-packet-hash', 'answered', '{"type":"noul","noul":0.7}');
INSERT INTO attempts (attempt_sequence, attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms, settled_ms, result_json, execution_json)
VALUES
  (5, 'attempt-choice', 'run-follow-on', 'group-1', 'evaluation-choice', 'choice-packet-hash', 'owner-1', 'answered', 1791028800003, 1791028800004, '{"type":"choice","choice":"yes"}', '{"provider":"typesafe","model":"jev-latest","physicalAttempts":1}'),
  (6, 'attempt-noul', 'run-follow-on', 'group-1', 'evaluation-noul', 'noul-packet-hash', 'owner-1', 'answered', 1791028800005, 1791028800006, '{"type":"noul","noul":0.7}', '{"provider":"typesafe","model":"jev-latest","physicalAttempts":1}');
INSERT INTO attempt_evaluations (attempt_id, evaluation_id, failure_json) VALUES ('attempt-choice', 'evaluation-choice', NULL), ('attempt-noul', 'evaluation-noul', NULL);
INSERT INTO evaluation_answer_attempts (evaluation_id, attempt_id) VALUES ('evaluation-choice', 'attempt-choice'), ('evaluation-noul', 'attempt-noul');
INSERT INTO runs (run_id, submission_id, request_fingerprint, created_at, created_ms, label, status, request_json, evaluation_count, max_calls, used_calls, reserved_calls)
VALUES ('run-journey', 'submission-journey', 'journey-request-hash', '2026-10-03T13:00:00.000Z', 1791032400000, 'Journey study', 'completed', '{"request":{"kind":"journey"}}', 1, 2, 1, 0);
INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
VALUES ('group-journey', 'run-journey', 0, 'context-journey', 'reader-journey', '{"stage":"wrap-up"}', '["journey-score"]');
INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, status, result_json)
VALUES ('evaluation-journey', 'run-journey', 0, 'context-journey', 'reader-journey', 'journey-score', 'group-journey', 'turn-journey', 'ask-wrap-up', 'path-journey', 1, '{"question":{"type":"score","id":"journey-score"}}', 'journey-packet-hash', 'answered', '{"type":"score","score":0.6,"confidence":0.7}');
INSERT INTO journey_respondents (run_id, respondent_id, status, revision, events_json, route_json, outcome)
VALUES ('run-journey', 'reader-journey', 'completed', 2, '[{"kind":"exposed","itemId":"opening"},{"kind":"answered","questionId":"journey-score"}]', '["start","ask-wrap-up","done"]', 'completed');
INSERT INTO attempts (attempt_sequence, attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms, settled_ms, result_json, execution_json)
VALUES (7, 'attempt-journey', 'run-journey', 'group-journey', 'evaluation-journey', 'journey-packet-hash', 'owner-journey', 'answered', 1791032400001, 1791032400002, '{"type":"score","score":0.6}', '{"provider":"typesafe","model":"jev-latest","physicalAttempts":1}');
INSERT INTO attempt_evaluations (attempt_id, evaluation_id, failure_json) VALUES ('attempt-journey', 'evaluation-journey', NULL);
INSERT INTO evaluation_answer_attempts (evaluation_id, attempt_id) VALUES ('evaluation-journey', 'attempt-journey');
