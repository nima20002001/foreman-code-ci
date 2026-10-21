/** Additive PR #17 F10 fix. Never renumber persisted native events or Activity references. */
export const nativeEventSequenceMigration = {
  version: 1702,
  sql: `
    -- Migration-only locks stabilize the backfill, including legacy writers.
    -- Normal appends lock one execution, never every Run or a global sequence.
    lock table harness_executions, harness_native_events in access exclusive mode;
    alter table harness_executions
      add column if not exists native_event_next_sequence bigint not null default 0
        check (native_event_next_sequence >= 0);
    update harness_executions e set native_event_next_sequence = greatest(
      e.native_event_next_sequence,
      coalesce((select max(n.sequence::bigint) + 1 from harness_native_events n where n.execution_id=e.id), 0)
    );

    -- A VOLATILE function gets a fresh Read Committed snapshot for each internal
    -- statement. In particular the identity read happens AFTER the row-lock wait,
    -- not in the snapshot of the outer SELECT which invoked this function.
    -- SECURITY INVOKER preserves the caller's permissions and transaction.
    create or replace function append_harness_native_event(p_event jsonb)
      returns boolean language plpgsql volatile security invoker as $$
    declare
      v_execution_id text := p_event->>'executionId';
      v_connection_id text := p_event->>'connectionId';
      v_source_sequence integer := (p_event->>'sequence')::integer;
      v_sequence integer;
      v_run_id text;
      v_existing jsonb;
      v_record jsonb;
    begin
      if v_execution_id is null or v_source_sequence is null or v_source_sequence < 0 then
        raise exception using errcode='22023', message='Invalid native event identity.';
      end if;

      select e.run_id into v_run_id from harness_executions e
        where e.id=v_execution_id for update;
      if not found then
        raise exception using errcode='23503', message='The native event execution does not exist.';
      end if;

      if v_connection_id is not null then
        select n.record into v_existing from harness_native_events n
          where n.execution_id=v_execution_id and n.connection_id=v_connection_id
            and n.source_sequence=v_source_sequence;
        if found then
          if (v_existing - 'sequence') is distinct from (p_event - 'sequence') then
            raise exception using errcode='PNE01', message='Native event identity conflicts with stored history.';
          end if;
          -- Exact source replay is a no-op, including the durable allocator.
          return false;
        end if;
        update harness_executions set native_event_next_sequence=native_event_next_sequence+1
          where id=v_execution_id returning (native_event_next_sequence-1)::integer into v_sequence;
        v_record := jsonb_set(p_event, '{sequence}', to_jsonb(v_sequence));
      else
        -- Pre-connection history uses its original execution sequence as identity.
        -- Keep its replay and conflict rules; never overwrite or renumber it.
        select n.record into v_existing from harness_native_events n
          where n.execution_id=v_execution_id and n.sequence=v_source_sequence;
        if found then
          if v_existing is distinct from p_event then
            raise exception using errcode='PNE01', message='Native event identity conflicts with stored history.';
          end if;
          return false;
        end if;
        v_sequence := v_source_sequence;
        v_record := p_event;
        update harness_executions set native_event_next_sequence=greatest(native_event_next_sequence, v_sequence::bigint+1)
          where id=v_execution_id;
      end if;

      insert into harness_native_events(execution_id,sequence,record,connection_id,source_sequence)
        values (v_execution_id,v_sequence,v_record,v_connection_id,
          case when v_connection_id is not null then v_source_sequence end);
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
        values (v_run_id,'harness','harness_output',v_execution_id,(p_event->>'occurredAt')::timestamptz,
          jsonb_build_object('nativeEventSequence',v_sequence,'nativeEventType',p_event->>'type'));
      return true;
    end $$;
  `,
} as const
