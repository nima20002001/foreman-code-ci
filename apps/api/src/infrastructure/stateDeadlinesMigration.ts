/** Lock order for Run activity, a slot index for CI tickets whose executor outlived a deadline, and per-episode
 * cleanup deadlines. */
export const stateDeadlinesMigration = { version: 2026101520, sql: `
  -- Every activity writer locks the parent Run before the per-Run activity lock, the order Run writers use.
  -- Before, the foreign-key check took that Run lock after the advisory lock and deadlocked (40P01) against a
  -- Run writer that held the Run and waited for the activity lock.
  create or replace function order_run_activity_insert() returns trigger
  language plpgsql security invoker as $$
  begin
    perform 1 from runs where id=NEW.run_id for key share;
    perform pg_advisory_xact_lock(hashtextextended(
      current_schema() || ':run_activity:' || NEW.run_id, 0));
    -- Identity defaults run before BEFORE triggers; allocate the published value after the Run lock.
    NEW.sequence := nextval(pg_get_serial_sequence('run_activity', 'sequence'));
    return NEW;
  end $$;

  create index ci_runs_retained_executor_idx on ci_runs(host_key)
    where record#>>'{deadlineExceeded,executor}'='retained';

  alter table run_cleanup_intents add column deadline_exceeded_at timestamptz;
  -- A new cleanup episode starts its own deadline; retries within an episode keep the first request time.
  create function start_run_cleanup_episode() returns trigger language plpgsql as $$
  begin
    if NEW.pending and not OLD.pending then
      NEW.requested_at := clock_timestamp();
      NEW.deadline_exceeded_at := null;
    end if;
    return NEW;
  end $$;
  create trigger run_cleanup_episode before update on run_cleanup_intents
    for each row execute function start_run_cleanup_episode();

  alter table source_execution_materializations add column cleanup_deadline_exceeded_at timestamptz;
` } as const
