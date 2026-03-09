-- Representative sanitized pre-v11 snapshot data
-- Loaded after CREATE_TABLES + MIGRATION_V9 + MIGRATION_V10 on a schema-version-10 DB.

INSERT INTO goals (id, title, description, status, strategy, created_at)
VALUES
  ('g_active_ghost', 'Legacy Ghost Goal', 'Active goal with no tasks', 'active', 'legacy_strategy_a', '2026-03-05T00:01:00.000Z'),
  ('g_active_valid', 'Legacy Active Goal', 'Active goal with executable tasks', 'active', 'legacy_strategy_b', '2026-03-05T00:02:00.000Z'),
  ('g_paused', 'Paused Goal', 'Paused legacy goal should not be remapped as active', 'paused', 'legacy_strategy_c', '2026-03-05T00:03:00.000Z');

INSERT INTO task_graph (
  id, parent_id, goal_id, title, description, status, assigned_to, agent_role, priority,
  dependencies, result, estimated_cost_cents, actual_cost_cents, max_retries, retry_count,
  timeout_ms, created_at, started_at, completed_at
)
VALUES
  (
    't_active_1', NULL, 'g_active_valid', 'Legacy task one', 'First legacy task', 'pending',
    NULL, NULL, 70, '[]', NULL, 15, 0, 3, 0, 300000,
    '2026-03-05T00:02:30.000Z', NULL, NULL
  ),
  (
    't_active_2', NULL, 'g_active_valid', 'Legacy task two', 'Second legacy task', 'completed',
    NULL, NULL, 50, '[]', '{"ok":true}', 10, 11, 3, 0, 300000,
    '2026-03-05T00:02:40.000Z', '2026-03-05T00:02:45.000Z', '2026-03-05T00:03:10.000Z'
  );
