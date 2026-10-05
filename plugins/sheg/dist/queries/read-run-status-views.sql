SELECT r.*,
  (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'answered') AS completed_evaluations,
  (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'failed') AS failed_evaluations,
  (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'pending') AS pending_evaluations,
  EXISTS (SELECT 1 FROM attempts a JOIN attempt_evaluations ae USING (attempt_id)
    JOIN evaluations e ON e.run_id = a.run_id AND e.evaluation_id = ae.evaluation_id
    WHERE a.run_id = r.run_id AND a.status = 'failed' AND a.failure_scope = 'run' AND e.status = 'failed'
      AND a.attempt_sequence = (SELECT MAX(latest.attempt_sequence) FROM attempts latest WHERE latest.run_id = r.run_id AND latest.status = 'failed' AND latest.failure_scope = 'run')) AS retryable_shared_failure,
  (EXISTS (SELECT 1 FROM evaluations e JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
      WHERE e.run_id = r.run_id AND e.status = 'failed' AND jr.status = 'failed') AND
   NOT EXISTS (SELECT 1 FROM evaluations e LEFT JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
      WHERE e.run_id = r.run_id AND e.status = 'failed' AND (jr.respondent_id IS NULL OR jr.status <> 'failed' OR
        e.turn_id IS NULL OR length(trim(e.turn_id)) = 0 OR e.node_id IS NULL OR length(trim(e.node_id)) = 0 OR
        e.path_id IS NULL OR length(trim(e.path_id)) = 0 OR e.occurrence IS NULL OR e.occurrence < 1 OR
        length(trim(e.packet_json)) = 0 OR length(trim(e.packet_fingerprint)) = 0)) AND
   NOT EXISTS (SELECT e.respondent_id FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'failed'
      GROUP BY e.respondent_id HAVING COUNT(*) <> 1) AND
   NOT EXISTS (SELECT 1 FROM journey_respondents jr WHERE jr.run_id = r.run_id AND jr.status = 'failed' AND
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = jr.run_id AND e.respondent_id = jr.respondent_id AND e.status = 'failed') <> 1)) AS retryable_journey_failure
FROM runs r WHERE r.run_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_ms, r.run_id
