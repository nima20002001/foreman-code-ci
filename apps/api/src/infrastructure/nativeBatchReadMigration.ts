/** Keep the lock wait and the following READ COMMITTED replay snapshot on the server. */
export const nativeBatchReadMigration = { version: 2026101801, sql: `
  create function read_harness_native_event_batch(p_identities jsonb)
    returns table(allocators json, events json) language plpgsql volatile security invoker as $$
  begin
    perform e.id from harness_executions e
      where e.id in (select p.execution_id from jsonb_to_recordset(p_identities) as p(execution_id text))
      order by e.id for update;

    -- A separate statement after the locks sees commits from writers we waited for.
    return query with replay_identities as materialized (
      select distinct p.execution_id,p.connection_id,p.source_sequence
      from jsonb_to_recordset(p_identities)
        as p(execution_id text,connection_id text,source_sequence integer)
    ), replay_events as (
      select n.execution_id,n.sequence,n.connection_id,n.source_sequence,n.record
        from harness_native_events n join replay_identities p on n.execution_id=p.execution_id
          and n.connection_id=p.connection_id and n.source_sequence=p.source_sequence
        where p.connection_id is not null
      union all
      select n.execution_id,n.sequence,n.connection_id,n.source_sequence,n.record
        from harness_native_events n join replay_identities p on n.execution_id=p.execution_id
          and n.sequence=p.source_sequence
        where p.connection_id is null
    ), execution_allocators as (
      select e.id,e.native_event_next_sequence::text as next_sequence from harness_executions e
        where e.id in (select p.execution_id from replay_identities p) order by e.id
    ) select coalesce((select json_agg(a) from execution_allocators a),'[]'::json),
      coalesce((select json_agg(n) from replay_events n),'[]'::json);
  end $$;
` } as const
