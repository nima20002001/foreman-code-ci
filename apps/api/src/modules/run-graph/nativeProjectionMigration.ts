/** Agent 5: additive internal state only; no backfill, new counter, or activation table. */
export const nativeProjectionMigration = {
  version: 250005,
  sql: `
    create table run_native_projection_checkpoints (
      run_id text not null references runs(id) on delete cascade,
      execution_id text not null, workflow_node_id text not null, attempt integer not null,
      work_kind text not null check(work_kind in ('workflow','review')), work_id text not null,
      revision bigint not null check(revision>=0),
      checkpoint jsonb not null check(jsonb_typeof(checkpoint)='object' and octet_length(checkpoint::text)<=131072),
      primary key(run_id,execution_id,work_kind,work_id),
      foreign key(run_id,execution_id,workflow_node_id,attempt)
        references harness_executions(run_id,id,workflow_node_id,attempt),
      check(work_kind<>'workflow' or work_id=execution_id)
    );
    -- Finished work remains in the detail tables; compact reads do not traverse it.
    create index run_native_activity_current_idx on run_native_activity(run_id,workflow_node_id,execution_id,work_kind,work_id)
      where activity->>'status' in ('active','stale','unknown');
    create index run_native_activity_workflow_idx on run_native_activity(run_id,workflow_node_id) where work_kind='workflow';
    create index run_graph_execution_current_idx on harness_executions(run_id,workflow_node_id,id);
    create index run_graph_interaction_open_idx on durable_interactions(run_id,id)
      where status not in ('delivered','canceled');
    create index run_graph_review_unsettled_idx on review_jobs(execution_id,id)
      where (record->>'state'<>'completed' and
        (record->>'state'<>'failed' or record->'cleanup'->>'completedAt' is null));
  `,
} as const
