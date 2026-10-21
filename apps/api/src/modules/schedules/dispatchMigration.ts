/** SCH-04. Append AFTER workflowScheduleMigration (270203); never amend an
 * applied migration. Existing audit actors are deliberately NOT backfilled as
 * durable authorization. Re-save/enable binds an explicit current root owner. */
export const workflowScheduleDispatchMigration = {
  version: 270204,
  sql: `
    create table workflow_schedule_authorities (
      workflow_id text primary key,
      workspace_id text not null,
      schedule_revision bigint not null check(schedule_revision between 1 and 9007199254740991),
      owner_principal_id text not null references management_principals(id),
      actor_principal_id text not null references management_principals(id),
      grant_ceiling jsonb not null check(jsonb_typeof(grant_ceiling)='array'),
      foreign key(workspace_id,workflow_id) references workflow_schedules(workspace_id,workflow_id)
    );
    create index workflow_schedule_inflight_idx
      on workflow_schedule_occurrences(workspace_id,workflow_id,run_id) where status='accepted';

    -- A new slot is sole schedule authority even when disabled/cleared. Lock
    -- the same workflow row as new schedule commands before enabling legacy
    -- scheduling. Other legacy trigger kinds are not changed.
    create function guard_legacy_workflow_schedule() returns trigger language plpgsql as $$
    begin
      if NEW.record->>'kind'='schedule' then
        perform id from workflows where id=NEW.workflow_id and workspace_id=NEW.workspace_id for update;
        if exists(select 1 from workflow_schedules where workflow_id=NEW.workflow_id) then
          NEW.enabled := false;
          NEW.next_fire_at := null;
          NEW.record := jsonb_set(NEW.record,'{enabled}','false'::jsonb);
          NEW.last_error := 'SCHEDULE_REPLACED';
        end if;
      end if;
      return NEW;
    end;
    $$;
    create trigger workflow_trigger_new_schedule_guard before insert or update on workflow_triggers
      for each row execute function guard_legacy_workflow_schedule();

    create function suppress_legacy_workflow_schedule() returns trigger language plpgsql as $$
    begin
      update workflow_triggers set enabled=false,next_fire_at=null,
        record=jsonb_set(record,'{enabled}','false'::jsonb),last_error='SCHEDULE_REPLACED'
        where workflow_id=NEW.workflow_id and workspace_id=NEW.workspace_id and record->>'kind'='schedule'
          and (enabled or next_fire_at is not null or last_error is distinct from 'SCHEDULE_REPLACED');
      return NEW;
    end;
    $$;
    create trigger workflow_schedule_suppresses_legacy after insert on workflow_schedules
      for each row execute function suppress_legacy_workflow_schedule();
    update workflow_triggers legacy set enabled=false,next_fire_at=null,
      record=jsonb_set(legacy.record,'{enabled}','false'::jsonb),last_error='SCHEDULE_REPLACED'
      where legacy.record->>'kind'='schedule'
        and exists(select 1 from workflow_schedules schedule where schedule.workflow_id=legacy.workflow_id);
  `,
} as const
