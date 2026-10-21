export const jobQueueCleanupMigration = { version: 285902, sql: `
alter table source_preparation_reconciliations add column queue_ticket_id uuid
  references job_admission_queue(id);
create unique index source_preparation_queue_cleanup on source_preparation_reconciliations(queue_ticket_id)
  where queue_ticket_id is not null;
` } as const
