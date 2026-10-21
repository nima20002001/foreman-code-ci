/** Append-only projections retain the exact Run/version and accepted source identity. */
export const workflowHierarchyMigration = { version: 2026102101, sql: String.raw`
create table run_hierarchy_reports (
  id text primary key,
  sequence bigint generated always as identity unique,
  workspace_id text not null references workspaces(id),
  workflow_id text not null references workflows(id),
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  workflow_node_id text not null,
  parent_node_id text not null,
  execution_id text not null references harness_executions(id),
  parent_request_id text not null references run_work_requests(request_id),
  source_event_key text not null,
  record jsonb not null,
  unique (run_id,source_event_key),
  check (record->>'id' = id),
  check (record #>> '{agent,workspaceId}' = workspace_id),
  check (record #>> '{agent,workflowId}' = workflow_id),
  check (record #>> '{agent,workflowNodeId}' = workflow_node_id),
  check (record #>> '{execution,runId}' = run_id),
  check (record #>> '{execution,workflowVersionId}' = workflow_version_id),
  check (record #>> '{execution,executionId}' = execution_id),
  check (record->>'parentNodeId' = parent_node_id),
  check (record->>'parentRequestId' = parent_request_id),
  check (record->>'sourceEventKey' = source_event_key)
);
create index run_hierarchy_reports_run on run_hierarchy_reports(run_id,sequence desc);
create index run_hierarchy_reports_parent on run_hierarchy_reports(run_id,parent_node_id,sequence desc);
create index run_hierarchy_reports_node on run_hierarchy_reports(run_id,workflow_node_id,sequence desc);
create trigger hierarchy_report_no_update before update on run_hierarchy_reports
  for each row execute function reject_work_evidence_update();
create constraint trigger hierarchy_report_retention after delete on run_hierarchy_reports
  deferrable initially deferred for each row execute function assert_work_evidence_retention();
create trigger hierarchy_report_no_truncate before truncate on run_hierarchy_reports
  for each statement execute function reject_work_evidence_truncate();
` } as const
