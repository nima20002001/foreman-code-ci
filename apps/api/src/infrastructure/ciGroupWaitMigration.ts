/** Wake group waiters when a ticket joins its group or its collection state changes; payloads carry the group. */
export const ciGroupWaitMigration = { version: 2026101504, sql: `
  create or replace function notify_ci_ticket_changed() returns trigger language plpgsql as $$
  begin
    perform pg_notify('ci_ticket_changed', json_build_object(
      'workspaceId', new.workspace_id, 'ticketId', new.id, 'groupId', new.group_id)::text);
    return new;
  end;
  $$;
  drop trigger if exists ci_ticket_changed on ci_runs;
  create trigger ci_ticket_changed after update on ci_runs
    for each row when (
      old.record->>'state' is distinct from new.record->>'state'
      or old.record->>'step' is distinct from new.record->>'step'
      or old.record->>'collection' is distinct from new.record->>'collection'
    ) execute function notify_ci_ticket_changed();
  create trigger ci_ticket_inserted after insert on ci_runs
    for each row execute function notify_ci_ticket_changed();
` } as const
