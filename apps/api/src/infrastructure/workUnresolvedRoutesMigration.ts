export const workUnresolvedRoutesMigration = { version: 269306, sql: String.raw`
alter table run_work_unresolved drop constraint run_work_unresolved_run_id_execution_id_key;
create unique index run_work_unresolved_route on run_work_unresolved(run_id,execution_id,relationship_id)
  where relationship_id is not null;
create unique index run_work_unresolved_finish on run_work_unresolved(run_id,execution_id)
  where relationship_id is null;
` } as const
