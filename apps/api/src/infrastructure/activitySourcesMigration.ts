/** Revisions belong to the existing authoritative records, not to another event log. */
export const activitySourcesMigration = {
  version: 282502,
  sql: `
    alter table operator_conversation_messages add column activity_record_revision bigint not null default 0;
    alter table operator_conversation_messages add column text_provenance jsonb;
    alter table harness_executions add column activity_record_revision bigint not null default 0;
    alter table files add column activity_record_revision bigint not null default 0;
    alter table runs add column activity_record_revision bigint not null default 0;
    create function advance_activity_record_revision() returns trigger language plpgsql as $$
    begin
      if (to_jsonb(new)-'activity_record_revision'-'text_provenance') is distinct from (to_jsonb(old)-'activity_record_revision'-'text_provenance') then
        new.activity_record_revision := old.activity_record_revision+1;
      else new.activity_record_revision := old.activity_record_revision; end if;
      return new;
    end $$;
    create trigger message_activity_record_revision before update on operator_conversation_messages
      for each row execute function advance_activity_record_revision();
    create trigger execution_activity_record_revision before update on harness_executions
      for each row execute function advance_activity_record_revision();
    create trigger file_activity_record_revision before update on files
      for each row execute function advance_activity_record_revision();
    create trigger run_activity_record_revision before update on runs
      for each row execute function advance_activity_record_revision();
  `,
}
