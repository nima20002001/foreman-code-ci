/** Reuse revisions on authoritative Job records; no parallel activity ledger. */
export const jobActivityRevisionMigration = {
  version: 283808,
  sql: `
    alter table job_executions add column activity_record_revision bigint not null default 0;
    create trigger job_execution_activity_record_revision before update on job_executions
      for each row execute function advance_activity_record_revision();
  `,
}
