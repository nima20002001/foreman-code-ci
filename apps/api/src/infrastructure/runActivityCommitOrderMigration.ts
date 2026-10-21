export const runActivityCommitOrderMigration = { version: 2026101011, sql: `
  create function order_run_activity_insert() returns trigger
  language plpgsql security invoker as $$
  begin
    perform pg_advisory_xact_lock(hashtextextended(
      current_schema() || ':run_activity:' || NEW.run_id, 0));
    -- Identity defaults run before BEFORE triggers; allocate the published value after the Run lock.
    NEW.sequence := nextval(pg_get_serial_sequence('run_activity', 'sequence'));
    return NEW;
  end $$;
  create trigger run_activity_commit_order before insert on run_activity
  for each row execute function order_run_activity_insert();
` } as const
