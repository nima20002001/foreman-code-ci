/** Wave 2.5 A1. Register exactly once after 170025; no legacy producer triggers. */
export const wave25RunGraphMigration = {
  version: 250001,
  sql: `
    alter table workflow_versions add column execution_semantics_version smallint not null default 1
      check (execution_semantics_version in (1,2));
    alter table workflow_versions add constraint run_graph_semantics_pin_matches_record
      check (execution_semantics_version=coalesce((record->>'executionSemanticsVersion')::smallint,1));
    -- Existing JSON records/checkpoints/native numbers are deliberately untouched.
    create unique index run_graph_execution_identity on harness_executions
      (run_id,id,workflow_node_id,attempt);

    create unique index run_graph_interaction_identity on durable_interactions (run_id,id);
    create unique index run_graph_review_host_identity on review_jobs (id,execution_id);
    create unique index run_graph_review_request_identity on review_jobs (id,execution_id,interaction_id);

    create table run_graph_heads (
      run_id text primary key references runs(id) on delete cascade,
      protocol_version smallint not null check (protocol_version=1),
      head_sequence bigint not null default 0 check (head_sequence>=0),
      retention_floor bigint not null default 0 check (retention_floor>=0 and retention_floor<=head_sequence),
      history_coverage text not null check (history_coverage in ('from_admission','from_snapshot'))
    );
    create table run_graph_batches (
      run_id text not null references run_graph_heads(run_id) on delete cascade,
      sequence bigint not null check (sequence>0),
      batch_id uuid not null,
      publication_xid xid8 not null default pg_current_xact_id(),
      kind text not null check (kind in ('events','reset')),
      -- Compact canonical JSON text preserves the exact wire byte measurement.
      payload text,
      payload_bytes integer generated always as (coalesce(octet_length(payload),0)) stored,
      reset_reason text,
      primary key (run_id,sequence), unique (run_id,batch_id), unique (run_id,publication_xid),
      check ((kind='events' and payload is not null and octet_length(payload)<=65536 and reset_reason is null)
        or (kind='reset' and payload is null and reset_reason='atomic_change_too_large'))
    );
    create table run_graph_sources (
      run_id text not null references run_graph_heads(run_id) on delete cascade,
      source_kind text not null check (source_kind in
        ('run','execution','native_event','node_resolution','input_binding','interaction','delivery','review','cleanup')),
      source_id text not null check (octet_length(source_id)<=200),
      source_revision bigint not null check (source_revision>=0),
      source_digest text not null check (source_digest ~ '^sha256:[0-9a-f]{64}$'),
      semantic_digest text not null check (semantic_digest ~ '^sha256:[0-9a-f]{64}$'),
      first_sequence bigint not null check (first_sequence>0),
      primary key (run_id,source_kind,source_id,source_revision)
      -- Not an FK to the retained journal: deduplication survives journal expiration.
    );

    create table run_node_resolutions (
      run_id text not null references runs(id) on delete cascade,
      workflow_node_id text not null,
      resolution text not null check (resolution in ('succeeded','failed','canceled','skipped','excluded')),
      execution_id text, attempt integer, record jsonb not null,
      primary key (run_id,workflow_node_id),
      foreign key (run_id,execution_id,workflow_node_id,attempt)
        references harness_executions(run_id,id,workflow_node_id,attempt),
      check ((resolution in ('skipped','excluded') and execution_id is null and attempt is null)
        or (resolution not in ('skipped','excluded') and execution_id is not null and attempt=1)),
      check (record->>'workflowNodeId'=workflow_node_id and record->>'resolution'=resolution)
    );
    create table run_input_bindings (
      run_id text not null references runs(id) on delete cascade,
      binding_id text not null,
      relationship_id text not null,
      sender_execution_id text not null, sender_node_id text not null, sender_attempt integer not null check (sender_attempt=1),
      recipient_execution_id text not null, recipient_node_id text not null, recipient_attempt integer not null check (recipient_attempt=1),
      accepted_result_digest text not null check (accepted_result_digest ~ '^sha256:[0-9a-f]{64}$'),
      recipient_input_digest text not null check (recipient_input_digest ~ '^sha256:[0-9a-f]{64}$'),
      input_ordinal integer not null check (input_ordinal>=0 and input_ordinal<8000),
      record jsonb not null,
      primary key (run_id,binding_id), unique (run_id,recipient_execution_id,relationship_id),
      unique (run_id,recipient_execution_id,input_ordinal),
      foreign key (run_id,sender_execution_id,sender_node_id,sender_attempt)
        references harness_executions(run_id,id,workflow_node_id,attempt),
      foreign key (run_id,recipient_execution_id,recipient_node_id,recipient_attempt)
        references harness_executions(run_id,id,workflow_node_id,attempt),
      check (sender_execution_id<>recipient_execution_id and sender_node_id<>recipient_node_id)
    );

    -- A completed workflow host can perform later independent review work.
    -- These are current projections/correlations, not activations or raw-event copies.
    create table run_native_activity (
      run_id text not null references runs(id) on delete cascade,
      execution_id text not null, workflow_node_id text not null, attempt integer not null,
      work_kind text not null check (work_kind in ('workflow','review')), work_id text not null,
      review_job_id text generated always as (case when work_kind='review' then work_id end) stored,
      foreign key (review_job_id,execution_id) references review_jobs(id,execution_id),
      last_native_sequence bigint check (last_native_sequence>=0),
      terminal_native_sequence bigint check (terminal_native_sequence>=0),
      projection_revision bigint not null check (projection_revision>=0),
      activity jsonb not null,
      primary key (run_id,execution_id,work_kind,work_id),
      foreign key (run_id,execution_id,workflow_node_id,attempt)
        references harness_executions(run_id,id,workflow_node_id,attempt),
      check (work_kind<>'workflow' or work_id=execution_id),
      check (terminal_native_sequence is null or
        (last_native_sequence is not null and terminal_native_sequence<=last_native_sequence))
    );
    create table run_native_correlations (
      run_id text not null references runs(id) on delete cascade,
      execution_id text not null, workflow_node_id text not null, attempt integer not null,
      work_kind text not null check (work_kind in ('workflow','review')), work_id text not null,
      correlation_key text not null check (octet_length(correlation_key)<=200),
      -- Internal exact-session identity; NEVER included in the public graph projection.
      provider text not null check (provider in ('codex','opencode')),
      native_session_id text not null, connection_id text, connection_generation integer not null check (connection_generation>=0),
      native_turn_id text, native_request_id text,
      interaction_id text, review_job_id text,
      foreign key (run_id,interaction_id) references durable_interactions(run_id,id),
      foreign key (review_job_id,execution_id,interaction_id) references review_jobs(id,execution_id,interaction_id),
      first_native_sequence bigint not null check (first_native_sequence>=0),
      last_native_sequence bigint not null check (last_native_sequence>=first_native_sequence),
      terminal_native_sequence bigint check (terminal_native_sequence>=first_native_sequence and terminal_native_sequence<=last_native_sequence),
      metadata_revision bigint not null check (metadata_revision>=0),
      primary key (run_id,execution_id,work_kind,work_id,correlation_key),
      foreign key (run_id,execution_id,workflow_node_id,attempt)
        references harness_executions(run_id,id,workflow_node_id,attempt),
      check ((work_kind='workflow' and work_id=execution_id and review_job_id is null)
        or (work_kind='review' and review_job_id is not null and interaction_id is not null and work_id=review_job_id))
    );
  `,
} as const
