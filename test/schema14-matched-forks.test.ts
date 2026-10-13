import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRunStore } from '../src/infrastructure/run-store.js';
import { applySchemaMigrations, registeredMigrations } from '../src/infrastructure/sqlite/schema.js';

async function schema13Journey(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-13-journey-'));
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    applySchemaMigrations(database, root, registeredMigrations(), 13);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`INSERT INTO runs
      (run_id, submission_id, request_fingerprint, created_at, created_ms, status, request_json, evaluation_count, max_calls, used_calls)
      VALUES ('run-1', 'submission-1', 'fingerprint-1', '2026-10-05T00:00:00.000Z', 1, 'completed', '{}', 1, 1, 1);
      INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
      VALUES ('group-1', 'run-1', 0, 'context-1', 'respondent-1', '{"history":["hello"]}', '["question-1"]');
      INSERT INTO evaluations
        (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, provider_selection_json, status, result_json)
      VALUES ('evaluation-1', 'run-1', 0, 'context-1', 'respondent-1', 'question-1', 'group-1', 'turn-1', 'node-1', 'path-1', 1, '{"stimulus":"hello"}', 'packet-1', '{"providerId":"jev"}', 'answered', '{"kind":"choice","value":"yes"}');
      INSERT INTO journey_respondents
        (run_id, respondent_id, status, current_node_id, current_turn_id, current_context_id, revision, events_json, route_json)
      VALUES ('run-1', 'respondent-1', 'active', 'node-2', 'turn-2', 'context-2', 3, '[{"kind":"read"}]', '["node-1"]');
      INSERT INTO attempts
        (attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms, settled_ms, charged_calls, result_json, execution_json)
      VALUES ('attempt-1', 'run-1', 'group-1', 'evaluation-1', 'packet-1', 'worker-1', 'answered', 1, 2, 1, '{}', '{"provider":"jev"}');
      INSERT INTO attempt_evaluations (run_id, attempt_id, evaluation_id) VALUES ('run-1', 'attempt-1', 'evaluation-1');
      INSERT INTO evaluation_answer_attempts (run_id, evaluation_id, attempt_id) VALUES ('run-1', 'evaluation-1', 'attempt-1');`);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally { database.close(); }
}

test('schema 13 journey evidence migrates intact into root branch and matched-fork identities', async () => {
  const root = await schema13Journey();
  try {
    const before = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
    const evidenceBefore = {
      respondent: before.prepare('SELECT * FROM journey_respondents').get(),
      evaluation: { ...(before.prepare('SELECT * FROM evaluations').get() as Record<string, unknown>) },
      attempt: before.prepare('SELECT * FROM attempts').get(),
      links: before.prepare('SELECT * FROM attempt_evaluations').all(),
      answer: before.prepare('SELECT * FROM evaluation_answer_attempts').all(),
    };
    before.close();

    const store = openRunStore(root);
    store.close();
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { enableForeignKeyConstraints: true });
    try {
      assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14);
      const respondent = { ...(database.prepare('SELECT branch_id, status, current_node_id, current_turn_id, current_context_id, revision, events_json, route_json FROM journey_respondents').get() as Record<string, unknown>) };
      assert.deepEqual(respondent, { branch_id: 'root', status: 'active', current_node_id: 'node-2', current_turn_id: 'turn-2', current_context_id: 'context-2', revision: 3, events_json: '[{"kind":"read"}]', route_json: '["node-1"]' });
      const evaluationAfter = { ...(database.prepare('SELECT * FROM evaluations').get() as Record<string, unknown>) };
      assert.equal(evaluationAfter.branch_id, 'root');
      delete evaluationAfter.branch_id;
      assert.deepEqual(evaluationAfter, evidenceBefore.evaluation);
      assert.deepEqual(database.prepare('SELECT * FROM attempts').get(), evidenceBefore.attempt);
      assert.deepEqual(database.prepare('SELECT * FROM attempt_evaluations').all(), evidenceBefore.links);
      assert.deepEqual(database.prepare('SELECT * FROM evaluation_answer_attempts').all(), evidenceBefore.answer);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal((database.prepare("SELECT migration_id FROM schema_migrations WHERE version = 14").get() as { migration_id: string } | undefined)?.migration_id, 'matched-forks-v14');

      database.prepare(`INSERT INTO journey_respondents
        (run_id, respondent_id, branch_id, status, revision, events_json, route_json)
        VALUES ('run-1', 'respondent-1', 'condition-b', 'completed', 0, '[]', '[]')`).run();
      database.prepare(`INSERT INTO journey_respondents
        (run_id, respondent_id, branch_id, status, revision, events_json, route_json)
        VALUES ('run-1', 'respondent-1', 'condition-a', 'completed', 0, '[]', '[]')`).run();
      assert.throws(() => database.prepare(`INSERT INTO journey_respondents
        (run_id, respondent_id, branch_id, status, revision, events_json, route_json)
        VALUES ('run-1', 'respondent-1', 'condition-a', 'completed', 0, '[]', '[]')`).run());

      database.prepare(`INSERT INTO evaluations
        (evaluation_id, run_id, ordinal, context_id, respondent_id, branch_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, status)
        VALUES ('evaluation-branch-a', 'run-1', 1, 'context-a', 'respondent-1', 'condition-a', 'question-1', 'group-1', 'turn-a', 'node-1', 'path-1', 1, '{}', 'packet-a', 'pending')`).run();
      database.prepare(`INSERT INTO evaluations
        (evaluation_id, run_id, ordinal, context_id, respondent_id, branch_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, status)
        VALUES ('evaluation-branch-b', 'run-1', 2, 'context-b', 'respondent-1', 'condition-b', 'question-1', 'group-1', 'turn-b', 'node-1', 'path-1', 1, '{}', 'packet-b', 'pending')`).run();
      assert.throws(() => database.prepare(`INSERT INTO evaluations
        (evaluation_id, run_id, ordinal, context_id, respondent_id, branch_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, status)
        VALUES ('evaluation-duplicate', 'run-1', 3, 'context-a2', 'respondent-1', 'condition-a', 'question-1', 'group-1', 'turn-a2', 'node-1', 'path-1', 1, '{}', 'packet-a2', 'pending')`).run());

      database.prepare(`INSERT INTO journey_respondents
        (run_id, respondent_id, branch_id, status, current_node_id, current_context_id, revision, events_json, route_json)
        VALUES ('run-1', 'respondent-2', 'root', 'waiting-fork', 'fork-1', 'context-1', 0, '[]', '[]')`).run();
      assert.throws(() => database.prepare(`INSERT INTO journey_respondents
        (run_id, respondent_id, branch_id, status, current_node_id, current_turn_id, current_context_id, revision, events_json, route_json)
        VALUES ('run-1', 'respondent-2', 'invalid-wait', 'waiting-fork', 'node-1', 'turn-invalid', 'context-invalid', 0, '[]', '[]')`).run());
      database.prepare(`INSERT INTO evaluations
        (evaluation_id, run_id, ordinal, context_id, respondent_id, branch_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, status)
        VALUES ('evaluation-shared-branch', 'run-1', 3, 'context-shared', 'respondent-2', 'condition-a', 'question-1', 'group-1', 'turn-shared', 'node-1', 'path-1', 1, '{}', 'packet-shared', 'pending')`).run();
      database.prepare(`INSERT INTO journey_forks (run_id, fork_node_id, parent_branch_id, status, cohort_count, opened_ms, revision)
        VALUES ('run-1', 'fork-1', 'root', 'open', 2, 10, 0)`).run();
      const insertMember = database.prepare(`INSERT INTO journey_fork_members
        (run_id, fork_node_id, parent_branch_id, respondent_id, condition_ordinal, condition_id, child_branch_id, source_context_id, child_context_id, child_turn_id, child_evaluation_id)
        VALUES ('run-1', 'fork-1', 'root', ?, 0, 'condition-a', 'condition-a', 'context-1', ?, ?, ?)`);
      insertMember.run('respondent-1', 'context-child-a', 'turn-child-a', 'evaluation-branch-a');
      insertMember.run('respondent-2', 'context-child-b', 'turn-child-b', 'evaluation-shared-branch');
      assert.throws(() => database.prepare(`INSERT INTO journey_fork_members
        (run_id, fork_node_id, parent_branch_id, respondent_id, condition_ordinal, condition_id, child_branch_id, source_context_id, child_context_id, child_turn_id, child_evaluation_id)
        VALUES ('run-1', 'fork-1', 'root', 'respondent-1', 1, 'condition-a-repeat', 'condition-a', 'context-1', 'context-repeat', 'turn-repeat', 'evaluation-branch-a')`).run());
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
