WITH next_ordinal AS (
  SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM evaluations WHERE run_id = ?
)
SELECT r.request_json, r.request_fingerprint, e.*, jr.status AS respondent_status,
  jr.current_node_id AS respondent_current_node_id, jr.current_turn_id AS respondent_current_turn_id,
  jr.current_context_id AS respondent_current_context_id, jr.revision AS respondent_revision,
  jr.events_json AS respondent_events_json, jr.route_json AS respondent_route_json, jr.outcome AS respondent_outcome,
  next_ordinal.value AS next_ordinal
FROM runs r JOIN evaluations e ON e.run_id = r.run_id
JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
CROSS JOIN next_ordinal
WHERE r.run_id = ? AND e.evaluation_id = ? AND e.respondent_id = ?
