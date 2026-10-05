import { sql } from 'drizzle-orm';
import {
  check, foreignKey, index, integer, primaryKey, sqliteTable, text, unique,
} from 'drizzle-orm/sqlite-core';

export const runs = sqliteTable('runs', {
  runId: text('run_id').notNull(),
  submissionId: text('submission_id').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  createdAt: text('created_at').notNull(),
  createdMs: integer('created_ms').notNull(),
  label: text('label'),
  status: text('status', { enum: ['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'] }).notNull(),
  requestJson: text('request_json').notNull(),
  evaluationCount: integer('evaluation_count').notNull(),
  maxCalls: integer('max_calls').notNull(),
  usedCalls: integer('used_calls').notNull().default(0),
  reservedCalls: integer('reserved_calls').notNull().default(0),
  cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
  ownerToken: text('owner_token'),
  ownerPid: integer('owner_pid'),
  leaseExpiresMs: integer('lease_expires_ms'),
  failureScope: text('failure_scope', { enum: ['evaluation', 'run'] }),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
}, (table) => [
  primaryKey({ name: 'runs_pk', columns: [table.runId] }),
  unique('runs_submission_id_uq').on(table.submissionId),
  unique('runs_run_submission_uq').on(table.runId, table.submissionId),
  check('runs_status_ck', sql`${table.status} IN ('prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted')`),
  check('runs_count_ck', sql`${table.evaluationCount} > 0 AND ${table.maxCalls} > 0 AND ${table.usedCalls} >= 0 AND ${table.reservedCalls} >= 0 AND ${table.usedCalls} + ${table.reservedCalls} <= ${table.maxCalls}`),
  check('runs_owner_ck', sql`(${table.status} = 'running' AND ${table.ownerToken} IS NOT NULL AND ${table.ownerPid} IS NOT NULL AND ${table.leaseExpiresMs} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.ownerToken} IS NULL AND ${table.ownerPid} IS NULL)`),
  check('runs_cancel_ck', sql`${table.cancelRequested} IN (0, 1)`),
  check('runs_failure_scope_ck', sql`${table.failureScope} IS NULL OR ${table.failureScope} IN ('evaluation', 'run')`),
  index('runs_created_identity').on(table.createdMs, table.runId),
  index('runs_expired_lease').on(table.leaseExpiresMs, table.runId),
]);

export const questionGroups = sqliteTable('question_groups', {
  groupId: text('group_id').notNull(),
  runId: text('run_id').notNull().references(() => runs.runId, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  contextId: text('context_id').notNull(),
  respondentId: text('respondent_id').notNull(),
  stateJson: text('state_json').notNull(),
  questionIdsJson: text('question_ids_json').notNull(),
}, (table) => [
  primaryKey({ name: 'question_groups_pk', columns: [table.groupId] }),
  unique('question_groups_run_ordinal_uq').on(table.runId, table.ordinal),
  unique('question_groups_run_group_uq').on(table.runId, table.groupId),
  check('question_groups_ordinal_ck', sql`${table.ordinal} >= 0`),
]);

export const evaluations = sqliteTable('evaluations', {
  evaluationId: text('evaluation_id').notNull(),
  runId: text('run_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  contextId: text('context_id').notNull(),
  respondentId: text('respondent_id').notNull(),
  questionId: text('question_id').notNull(),
  groupId: text('group_id').notNull(),
  turnId: text('turn_id'),
  nodeId: text('node_id'),
  pathId: text('path_id'),
  occurrence: integer('occurrence'),
  packetJson: text('packet_json').notNull(),
  packetFingerprint: text('packet_fingerprint').notNull(),
  status: text('status', { enum: ['pending', 'answered', 'failed', 'unreached'] }).notNull(),
  resultJson: text('result_json'),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  failureDetailJson: text('failure_detail_json'),
}, (table) => [
  primaryKey({ name: 'evaluations_pk', columns: [table.evaluationId] }),
  foreignKey({ name: 'evaluations_run_fk', columns: [table.runId], foreignColumns: [runs.runId] }).onDelete('cascade'),
  foreignKey({ name: 'evaluations_group_fk', columns: [table.runId, table.groupId], foreignColumns: [questionGroups.runId, questionGroups.groupId] }).onDelete('cascade'),
  unique('evaluations_run_ordinal_uq').on(table.runId, table.ordinal),
  unique('evaluations_run_eval_uq').on(table.runId, table.evaluationId),
  unique('evaluations_run_eval_group_uq').on(table.runId, table.evaluationId, table.groupId),
  unique('evaluations_run_turn_uq').on(table.runId, table.turnId),
  unique('evaluations_run_respondent_node_occurrence_uq').on(table.runId, table.respondentId, table.nodeId, table.occurrence),
  check('evaluations_status_ck', sql`${table.status} IN ('pending', 'answered', 'failed', 'unreached')`),
  check('evaluations_ordinal_ck', sql`${table.ordinal} >= 0`),
  check('evaluations_journey_identity_ck', sql`(${table.turnId} IS NULL AND ${table.nodeId} IS NULL AND ${table.pathId} IS NULL AND ${table.occurrence} IS NULL) OR (${table.turnId} IS NOT NULL AND ${table.nodeId} IS NOT NULL AND ${table.pathId} IS NOT NULL AND ${table.occurrence} >= 1)`),
  check('evaluations_answer_ck', sql`(${table.status} = 'answered' AND ${table.resultJson} IS NOT NULL AND ${table.failureCode} IS NULL) OR (${table.status} <> 'answered' AND ${table.resultJson} IS NULL)`),
  index('evaluations_pending_turn').on(table.runId, table.status, table.respondentId, table.ordinal),
]);

export const journeyRespondents = sqliteTable('journey_respondents', {
  runId: text('run_id').notNull().references(() => runs.runId, { onDelete: 'cascade' }),
  respondentId: text('respondent_id').notNull(),
  status: text('status', { enum: ['active', 'completed', 'failed', 'unreached'] }).notNull(),
  currentNodeId: text('current_node_id'),
  currentTurnId: text('current_turn_id'),
  currentContextId: text('current_context_id'),
  revision: integer('revision').notNull(),
  eventsJson: text('events_json').notNull(),
  routeJson: text('route_json').notNull(),
  outcome: text('outcome'),
}, (table) => [
  primaryKey({ name: 'journey_respondents_pk', columns: [table.runId, table.respondentId] }),
  check('journey_respondents_status_ck', sql`${table.status} IN ('active', 'completed', 'failed', 'unreached')`),
  check('journey_respondents_revision_ck', sql`${table.revision} >= 0`),
  check('journey_respondents_checkpoint_ck', sql`(${table.status} = 'active' AND ${table.currentNodeId} IS NOT NULL AND ${table.currentTurnId} IS NOT NULL AND ${table.currentContextId} IS NOT NULL) OR (${table.status} <> 'active' AND ${table.currentNodeId} IS NULL AND ${table.currentTurnId} IS NULL AND ${table.currentContextId} IS NULL)`),
]);

export const attempts = sqliteTable('attempts', {
  attemptSequence: integer('attempt_sequence').primaryKey({ autoIncrement: true }),
  attemptId: text('attempt_id').notNull(),
  runId: text('run_id').notNull(),
  groupId: text('group_id').notNull(),
  evaluationId: text('evaluation_id').notNull(),
  packetFingerprint: text('packet_fingerprint').notNull(),
  ownerToken: text('owner_token').notNull(),
  status: text('status', { enum: ['reserved', 'answered', 'failed', 'uncertain'] }).notNull(),
  startedMs: integer('started_ms').notNull(),
  settledMs: integer('settled_ms'),
  chargedCalls: integer('charged_calls').notNull().default(0),
  resultJson: text('result_json'),
  executionJson: text('execution_json'),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  failureScope: text('failure_scope', { enum: ['evaluation', 'run'] }),
}, (table) => [
  unique('attempts_attempt_id_uq').on(table.attemptId),
  unique('attempts_run_attempt_uq').on(table.runId, table.attemptId),
  foreignKey({ name: 'attempts_run_evaluation_group_fk', columns: [table.runId, table.evaluationId, table.groupId], foreignColumns: [evaluations.runId, evaluations.evaluationId, evaluations.groupId] }).onDelete('cascade'),
  foreignKey({ name: 'attempts_run_group_fk', columns: [table.runId, table.groupId], foreignColumns: [questionGroups.runId, questionGroups.groupId] }).onDelete('cascade'),
  check('attempts_status_ck', sql`${table.status} IN ('reserved', 'answered', 'failed', 'uncertain')`),
  check('attempts_call_ledger_ck', sql`${table.chargedCalls} >= 0 AND (${table.status} = 'reserved' OR ${table.settledMs} IS NOT NULL)`),
  check('attempts_settlement_ck', sql`(${table.status} = 'answered' AND ${table.executionJson} IS NOT NULL AND ${table.chargedCalls} >= 1) OR (${table.status} = 'failed' AND ${table.failureCode} IS NOT NULL) OR (${table.status} = 'uncertain' AND ${table.chargedCalls} >= 1) OR (${table.status} = 'reserved' AND ${table.settledMs} IS NULL AND ${table.chargedCalls} = 0)`),
  check('attempts_failure_scope_ck', sql`${table.failureScope} IS NULL OR ${table.failureScope} IN ('evaluation', 'run')`),
  index('attempts_run_sequence').on(table.runId, table.attemptSequence),
  index('attempts_run_status_sequence').on(table.runId, table.status, table.attemptSequence),
]);

export const attemptEvaluations = sqliteTable('attempt_evaluations', {
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  evaluationId: text('evaluation_id').notNull(),
  failureJson: text('failure_json'),
}, (table) => [
  primaryKey({ name: 'attempt_evaluations_pk', columns: [table.runId, table.attemptId, table.evaluationId] }),
  foreignKey({ name: 'attempt_evaluations_attempt_fk', columns: [table.runId, table.attemptId], foreignColumns: [attempts.runId, attempts.attemptId] }).onDelete('cascade'),
  foreignKey({ name: 'attempt_evaluations_evaluation_fk', columns: [table.runId, table.evaluationId], foreignColumns: [evaluations.runId, evaluations.evaluationId] }).onDelete('cascade'),
]);

export const evaluationAnswerAttempts = sqliteTable('evaluation_answer_attempts', {
  runId: text('run_id').notNull(),
  evaluationId: text('evaluation_id').notNull(),
  attemptId: text('attempt_id').notNull(),
}, (table) => [
  primaryKey({ name: 'evaluation_answer_attempts_pk', columns: [table.runId, table.evaluationId] }),
  foreignKey({ name: 'evaluation_answer_attempts_membership_fk', columns: [table.runId, table.attemptId, table.evaluationId], foreignColumns: [attemptEvaluations.runId, attemptEvaluations.attemptId, attemptEvaluations.evaluationId] }).onDelete('cascade'),
]);

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').notNull(),
  migrationId: text('migration_id').notNull(),
  checksum: text('checksum').notNull(),
  schemaFingerprint: text('schema_fingerprint').notNull(),
  appliedAt: text('applied_at').notNull(),
}, (table) => [
  primaryKey({ name: 'schema_migrations_pk', columns: [table.migrationId] }),
  unique('schema_migrations_version_uq').on(table.version),
  check('schema_migrations_version_ck', sql`${table.version} > 0`),
]);

export const sqliteTables = {
  runs, questionGroups, evaluations, journeyRespondents, attempts,
  attemptEvaluations, evaluationAnswerAttempts, schemaMigrations,
} as const;

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
