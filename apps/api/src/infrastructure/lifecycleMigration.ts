/** Review/reconnect identities extend existing rows without renumbering their history. */
export const lifecycleMigration = {
  version: 509,
  sql: `
    alter table management_principals drop constraint management_principals_audience_check;
    alter table management_principals add constraint management_principals_audience_check
      check (audience in ('operator','worker','user'));
    alter table worker_credential_bindings add column purpose text not null default 'workflow'
      check (purpose in ('workflow','reviewer'));
    create table execution_native_sessions (
      execution_id text primary key references harness_executions(id) on delete cascade,
      reference jsonb not null,
      workflow_finalized_at timestamptz
    );
    -- Recover identities already persisted by the previous runtime, without starting a provider.
    insert into execution_native_sessions (execution_id,reference,workflow_finalized_at)
      select distinct on (he.id) he.id,
        jsonb_build_object('harness',d.harness,'providerVersion',d.record->>'providerVersion',
          'nativeSessionId',he.record->>'nativeSessionId'),
        case when he.record->>'state'='completed' then now() end
      from harness_executions he join durable_interactions d on d.execution_id=he.id
      where he.record->>'nativeSessionId'=d.native_session_id order by he.id,d.created_at desc;
    -- PR #15 only qualified these two protocol versions. Completed reviewers
    -- may never have asked for approval, so no interaction carries their reference.
    insert into execution_native_sessions (execution_id,reference,workflow_finalized_at)
      select he.id,jsonb_build_object('harness',c.record->'harness'->>'harness',
        'providerVersion',case c.record->'harness'->>'harness' when 'codex' then 'codex-cli 0.154.0' else '1.18.31' end,
        'nativeSessionId',he.record->>'nativeSessionId'),
        case when he.record->>'state'='completed' and not exists (
          select 1 from worker_credential_bindings b where b.execution_id=he.id and b.revoked_at is null
        ) then now() end
      from harness_executions he join agent_configuration_versions c on c.id=he.record->>'agentConfigurationVersionId'
      where he.record->>'nativeSessionId' is not null on conflict (execution_id) do nothing;
    alter table harness_native_events add column connection_id text, add column source_sequence integer;
    create unique index native_event_source_identity
      on harness_native_events(execution_id,connection_id,source_sequence);
    create sequence native_event_ingestion_sequence;
    select setval('native_event_ingestion_sequence',
      coalesce((select max(sequence)::bigint+1 from harness_native_events),1),false);
  `,
} as const
