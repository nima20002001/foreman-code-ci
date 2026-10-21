/** Wake CI readers only when a persisted ticket changes state or step. */
export const ciTicketChangesMigration = { version: 2026101401, sql: `
  create function notify_ci_ticket_changed() returns trigger language plpgsql as $$
  begin
    perform pg_notify('ci_ticket_changed', json_build_object(
      'workspaceId', new.workspace_id, 'ticketId', new.id)::text);
    return new;
  end;
  $$;
  create trigger ci_ticket_changed after update on ci_runs
    for each row when (
      old.record->>'state' is distinct from new.record->>'state'
      or old.record->>'step' is distinct from new.record->>'step'
    ) execute function notify_ci_ticket_changed();
` } as const
