/** ENG-05 lane A: additive indexes only. No history rewrite, new occurrence,
 * receipt changes or execution semantics. Applied by the existing migration
 * transaction; never performed by an authenticated inspection request. */
export const runInspectionMigration = {
  version: 26090501,
  sql: `
    create index eng05_exec_run_page
      on harness_executions (run_id, created_at desc, id desc);
    create index eng05_exec_run_node_page
      on harness_executions (run_id, workflow_node_id, created_at desc, id desc);
    create index eng05_exec_run_occurrence_page
      on harness_executions (run_id, repeat_occurrence_id, created_at desc, id desc);
    create index eng05_exec_run_occurrence_node_page
      on harness_executions (run_id, repeat_occurrence_id, workflow_node_id, created_at desc, id desc);
    create index eng05_execution_bindings_page
      on run_repeat_bindings (run_id, recipient_execution_id, ordinal);
  `,
} as const
