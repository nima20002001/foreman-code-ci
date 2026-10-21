/** Existing command receipts remain the sole reservation/effect authority. */
export const activityCommandSourcesMigration = {
  version: 282503,
  sql: `alter table management_command_receipts add column activity_record_revision bigint not null default 0;
    create trigger command_activity_record_revision before update on management_command_receipts
      for each row execute function advance_activity_record_revision();`,
}
