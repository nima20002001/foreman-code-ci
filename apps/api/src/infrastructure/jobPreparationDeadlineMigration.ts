/** Durable workflow source preparation start; bookkeeping grants no launch right. */
export const jobPreparationDeadlineMigration={version:283805,sql:String.raw`
alter table workflow_job_preparations add column created_at timestamptz not null default clock_timestamp();
`}
