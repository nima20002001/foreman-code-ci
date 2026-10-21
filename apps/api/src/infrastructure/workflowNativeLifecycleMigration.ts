/** A2 native/lifecycle records, based on be4ad. A3 must reconcile this registry
 * slot and common-table naming before integration. No legacy Run/native proof
 * is fabricated or backfilled. Ordinary executions have NULL occurrence refs;
 * none of these tables creates a repeat block/round/carry/decision. */
export const workflowNativeLifecycleMigration = { version: 264602, sql: String.raw`
create table workflow_native_entries (
  execution_id text primary key references harness_executions(id),
  run_id text not null references runs(id),
  reservation jsonb not null,
  reservation_json text not null check(octet_length(reservation_json)<=4194304),
  reservation_digest text not null check(reservation_digest='sha256:'||encode(sha256(convert_to(reservation_json,'UTF8')),'hex')),
  phase text not null check(phase in ('reserved','prepared','entered','not_submitted')),
  transition jsonb,
  source_id text,
  source_digest text check(source_digest ~ '^sha256:[0-9a-f]{64}$'),
  check(reservation=reservation_json::jsonb),
  check((reservation#>>'{execution,executionId}') is not distinct from execution_id),
  check((reservation#>>'{scope,runId}') is not distinct from run_id),
  check((reservation#>'{scope,executionSemanticsVersion}') is not distinct from '3'::jsonb),
  check((phase='reserved' and transition is null and source_id is null and source_digest is null)
    or (phase<>'reserved' and jsonb_typeof(transition)='object' and source_id is not null and source_digest is not null
      and transition->'reservation'=reservation and transition->>'phase'=phase))
);
create index workflow_native_entries_run on workflow_native_entries(run_id,execution_id);
create table workflow_native_proofs (
  proof_id text primary key,
  run_id text not null references runs(id),
  execution_id text not null references harness_executions(id),
  identity_digest text not null check(identity_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_digest text not null,
  record jsonb not null,
  record_json text not null check(octet_length(record_json)<=4194304),
  check(record=record_json::jsonb),
  check(source_digest='sha256:'||encode(sha256(convert_to(record_json,'UTF8')),'hex')),
  check((record->>'proofId') is not distinct from proof_id),
  check((record#>>'{scope,runId}') is not distinct from run_id),
  check((record#>>'{execution,executionId}') is not distinct from execution_id),
  check((record#>'{scope,executionSemanticsVersion}') is not distinct from '3'::jsonb),
  check((record#>>'{original,type}') in ('session_created','event','history'))
);
create index workflow_native_proofs_execution on workflow_native_proofs(run_id,execution_id,proof_id);
alter table durable_interactions add column approval_native_request_proof_id text references workflow_native_proofs(proof_id);

create table review_native_proofs (
  proof_id text primary key,
  run_id text not null references runs(id),
  execution_id text not null references harness_executions(id),
  job_id text not null references review_jobs(id),
  source_digest text not null,
  record jsonb not null,
  record_json text not null check(octet_length(record_json)<=4194304),
  check(record=record_json::jsonb),
  check(source_digest='sha256:'||encode(sha256(convert_to(record_json,'UTF8')),'hex')),
  check((record->>'proofId') is not distinct from proof_id),
  check((record#>>'{scope,runId}') is not distinct from run_id),
  check((record#>>'{execution,executionId}') is not distinct from execution_id),
  check((record#>>'{job,id}') is not distinct from job_id),
  check((record#>'{scope,executionSemanticsVersion}') is not distinct from '3'::jsonb),
  check((record#>>'{original,type}') in ('entry','event','history'))
);
create index review_native_proofs_execution on review_native_proofs(run_id,execution_id,job_id,proof_id);
alter table review_jobs add column approval_original_proof_id text references review_native_proofs(proof_id);
create table review_native_entries (
  job_id text primary key references review_jobs(id),
  run_id text not null references runs(id),
  execution_id text not null references harness_executions(id),
  phase text not null check(phase in ('reserved','entered','not_submitted')),
  record jsonb not null,
  record_json text not null check(octet_length(record_json)<=4194304),
  entry_proof_id text references review_native_proofs(proof_id),
  source_id text,
  source_revision bigint check(source_revision>=0),
  source_digest text check(source_digest ~ '^sha256:[0-9a-f]{64}$'),
  check(record=record_json::jsonb),
  check((record#>>'{scope,runId}') is not distinct from run_id),
  check((record#>>'{execution,executionId}') is not distinct from execution_id),
  check((record#>>'{job,id}') is not distinct from job_id),
  check((record#>'{scope,executionSemanticsVersion}') is not distinct from '3'::jsonb),
  check((phase='reserved' and source_id is null and source_revision is null and source_digest is null and entry_proof_id is null)
    or (phase<>'reserved' and source_id is not null and source_revision is not null and source_digest is not null
      and ((phase='entered' and entry_proof_id is not null) or (phase='not_submitted' and entry_proof_id is null))))
);
create index review_native_entries_run on review_native_entries(run_id,execution_id,job_id);

create table workflow_stop_intents (
  principal_id text not null references management_principals(id),
  command_id text not null check(command_id<>''),
  workspace_id text not null references workspaces(id),
  run_id text not null references runs(id),
  request_hash text not null check(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_id text not null,
  source_digest text not null,
  record jsonb not null,
  record_json text not null check(octet_length(record_json)<=4194304),
  primary key(principal_id,command_id),
  check(record=record_json::jsonb),
  check(source_digest='sha256:'||encode(sha256(convert_to(record_json,'UTF8')),'hex')),
  check((record->>'principalId') is not distinct from principal_id),
  check((record->>'commandId') is not distinct from command_id),
  check((record->>'workspaceId') is not distinct from workspace_id),
  check((record->>'runId') is not distinct from run_id),
  check((record->>'requestHash') is not distinct from request_hash),
  check((record#>'{receipt,processStopped}') is not distinct from 'false'::jsonb),
  check((record#>>'{receipt,runId}') is not distinct from run_id),
  check((record#>>'{receipt,status}') in ('accepted','already_terminal'))
);
create index workflow_stop_intents_run on workflow_stop_intents(run_id,principal_id,command_id);

create table run_graph_public_projection (
  run_id text primary key references runs(id),
  sequence bigint not null check(sequence>=1),
  record jsonb not null check(jsonb_typeof(record)='object'),
  source_id text not null,
  source_digest text not null check(source_digest ~ '^sha256:[0-9a-f]{64}$'),
  semantic_digest text not null check(semantic_digest ~ '^sha256:[0-9a-f]{64}$')
);
-- Do NOT backdate old binding facts. New binds receive their actual transaction
-- time. An old unqualified row with unknown bind time stays unknown/fail-closed.
alter table run_repeat_bindings add column bound_at timestamptz;
alter table run_repeat_bindings alter column bound_at set default transaction_timestamp();
alter table run_repeat_bindings add constraint current_binding_time_required check(bound_at is not null) not valid;

-- Assert the precise known preimage of the former bound-close-only check. Do
-- not broadly drop constraints based on a name pattern or rewrite old receipts.
create temporary table a2_expected_closure_check(closed_at timestamptz,closed_reference jsonb,
  constraint a2_bound_pair check((closed_at is null)=(closed_reference is null))) on commit drop;
do $$ begin
  if (select pg_get_expr(conbin,conrelid) from pg_constraint where conrelid='execution_native_closures'::regclass
      and conname='execution_native_closures_check' and contype='c') is distinct from
    (select pg_get_expr(conbin,conrelid) from pg_constraint where conrelid='a2_expected_closure_check'::regclass and conname='a2_bound_pair') then
    raise exception 'A2_CLOSURE_CONSTRAINT_DRIFT';
  end if;
end $$;
drop table a2_expected_closure_check;
alter table execution_native_closures drop constraint execution_native_closures_check;
alter table execution_native_closures add column closed_without_session boolean not null default false;
alter table execution_native_closures add column detached_at timestamptz;
alter table execution_native_closures add column detached_reference jsonb;
alter table execution_native_closures add constraint current_closure_shape check (
  ((closed_at is null and closed_reference is null and not closed_without_session)
   or (closed_at is not null and detached_at is null and
     ((closed_without_session and closed_reference is null and expected_reference is null)
      or (not closed_without_session and jsonb_typeof(closed_reference)='object'))))
  and ((detached_at is null and detached_reference is null)
    or (detached_at is not null and closed_at is null and jsonb_typeof(detached_reference)='object'))
);
create or replace function immutable_execution_native_closure() returns trigger language plpgsql as $$
begin
  if (to_jsonb(NEW)-array['closed_reference','closed_at','closed_without_session','detached_at','detached_reference'])
      is distinct from (to_jsonb(OLD)-array['closed_reference','closed_at','closed_without_session','detached_at','detached_reference'])
    or ((OLD.closed_at is not null or OLD.detached_at is not null) and to_jsonb(NEW) is distinct from to_jsonb(OLD)) then
    raise exception 'NATIVE_WORKFLOW_CLOSURE_IMMUTABLE' using errcode='P2644';
  end if;
  return NEW;
end $$;

create function a2_native_record_immutable() returns trigger language plpgsql as $$
begin raise exception 'CURRENT_NATIVE_RECORD_IMMUTABLE' using errcode='P2602'; end $$;
create function a2_native_entry_monotonic() returns trigger language plpgsql as $$
begin
  if TG_OP<>'UPDATE' then raise exception 'CURRENT_NATIVE_ENTRY_IMMUTABLE' using errcode='P2602'; end if;
  if TG_TABLE_NAME='workflow_native_entries' then
    if (to_jsonb(NEW)-array['phase','transition','source_id','source_digest'])
        is distinct from (to_jsonb(OLD)-array['phase','transition','source_id','source_digest'])
      or not ((OLD.phase='reserved' and NEW.phase in ('prepared','not_submitted'))
        or (OLD.phase='prepared' and NEW.phase in ('entered','not_submitted'))) then
      raise exception 'CURRENT_NATIVE_ENTRY_IMMUTABLE' using errcode='P2602';
    end if;
  else
    if (to_jsonb(NEW)-array['phase','entry_proof_id','source_id','source_revision','source_digest'])
        is distinct from (to_jsonb(OLD)-array['phase','entry_proof_id','source_id','source_revision','source_digest'])
      or OLD.phase<>'reserved' or NEW.phase not in ('entered','not_submitted') then
      raise exception 'CURRENT_NATIVE_ENTRY_IMMUTABLE' using errcode='P2602';
    end if;
  end if;
  return NEW;
end $$;
create function a2_proof_committed() returns trigger language plpgsql as $$
declare current_row jsonb; r_id text; p_id text; digest text;
begin
  -- Deferred to canonical G1's finalizer. A fixture row without its actual
  -- source publication is not durable positive native proof.
  if TG_TABLE_NAME in ('workflow_native_proofs','review_native_proofs') then
    r_id:=NEW.run_id; p_id:=NEW.proof_id; digest:=NEW.source_digest;
    if not exists(select 1 from harness_executions e join runs r on r.id=e.run_id
      join workflow_versions v on v.id=r.workflow_version_id where e.id=NEW.execution_id and e.run_id=r_id
      and v.execution_semantics_version=3 and r.record->'executionSemanticsVersion'='3'::jsonb
      and NEW.record#>>'{scope,workflowVersionId}'=r.workflow_version_id
      and NEW.record#>>'{scope,workspaceId}'=r.workspace_id and NEW.record#>>'{scope,workflowId}'=r.workflow_id) then
      raise exception 'CURRENT_NATIVE_PROOF_PIN_CONFLICT' using errcode='P2602';
    end if;
    -- Use a nested branch: workflow proof rows have no job_id field. Do not
    -- rely on SQL AND evaluation order for a polymorphic trigger record.
    if TG_TABLE_NAME='review_native_proofs' then
      if not exists(select 1 from review_jobs j where j.id=NEW.job_id
        and j.execution_id=NEW.execution_id and j.interaction_id=NEW.record#>>'{job,interactionId}'
        and j.reviewer_agent_id=NEW.record#>>'{job,reviewerAgentId}') then
        raise exception 'CURRENT_REVIEW_PROOF_PIN_CONFLICT' using errcode='P2602';
      end if;
    end if;
    if not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
      where s.run_id=r_id and s.source_kind='native_event' and s.source_id=p_id and s.source_revision=1
        and s.source_digest=digest and s.first_sequence between 1 and h.head_sequence) then
      raise exception 'CURRENT_NATIVE_RECEIPT_REQUIRED' using errcode='P2602';
    end if;
  end if;
  return NEW;
end $$;
create function a2_entry_committed() returns trigger language plpgsql as $$
declare item record; kind text;
begin
  if TG_TABLE_NAME='workflow_native_entries' then
    select e.phase,e.run_id,e.source_id,1::bigint as source_revision,e.source_digest into item
      from workflow_native_entries e where e.execution_id=NEW.execution_id;
    kind:='execution';
  else
    select e.phase,e.run_id,e.source_id,e.source_revision,e.source_digest into item from review_native_entries e where e.job_id=NEW.job_id;
    kind:='review';
  end if;
  if item.phase<>'reserved' and not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
    where s.run_id=item.run_id and s.source_kind=kind and s.source_id=item.source_id and s.source_revision=item.source_revision
      and s.source_digest=item.source_digest and s.first_sequence between 1 and h.head_sequence) then
    raise exception 'CURRENT_NATIVE_ENTRY_RECEIPT_REQUIRED' using errcode='P2602';
  end if;
  return NEW;
end $$;
create function a2_stop_intent_committed() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from runs r where r.id=NEW.run_id and r.workspace_id=NEW.workspace_id
    and r.record->'executionSemanticsVersion'='3'::jsonb
    and ((NEW.record#>>'{receipt,status}'='accepted' and r.stop_requested_at is not null)
      or (NEW.record#>>'{receipt,status}'='already_terminal' and r.execution_state='completed')))
    or not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
      where s.run_id=NEW.run_id and s.source_kind='cleanup' and s.source_id=NEW.source_id
        and s.source_revision=1 and s.source_digest=NEW.source_digest
        and s.first_sequence between 1 and h.head_sequence) then
    raise exception 'CURRENT_STOP_INTENT_RECEIPT_REQUIRED' using errcode='P2602';
  end if;
  return NEW;
end $$;
create function a2_public_projection_committed() returns trigger language plpgsql as $$
declare item run_graph_public_projection%rowtype;
begin
  select * into item from run_graph_public_projection where run_id=NEW.run_id;
  if not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
    where s.run_id=item.run_id and s.source_kind='run' and s.source_id=item.source_id and s.source_revision=item.sequence
      and s.source_digest=item.source_digest and s.semantic_digest=item.semantic_digest
      and s.first_sequence=item.sequence and item.sequence<=h.head_sequence) then
    raise exception 'CURRENT_PUBLIC_PROJECTION_RECEIPT_REQUIRED' using errcode='P2602';
  end if;
  return NEW;
end $$;
do $$ declare t text; begin
  foreach t in array array['workflow_native_proofs','review_native_proofs','workflow_stop_intents'] loop
    execute format('create trigger a2_record_immutable before update or delete on %I for each row execute function a2_native_record_immutable()',t);
    execute format('create trigger a2_record_no_truncate before truncate on %I for each statement execute function a2_native_record_immutable()',t);
  end loop;
  foreach t in array array['workflow_native_entries','review_native_entries'] loop
    execute format('create trigger a2_entry_monotonic before update or delete on %I for each row execute function a2_native_entry_monotonic()',t);
    execute format('create trigger a2_entry_no_truncate before truncate on %I for each statement execute function a2_native_record_immutable()',t);
    execute format('create constraint trigger a2_entry_receipt after insert or update on %I deferrable initially deferred for each row execute function a2_entry_committed()',t);
  end loop;
  foreach t in array array['workflow_native_proofs','review_native_proofs'] loop
    execute format('create constraint trigger a2_native_receipt after insert on %I deferrable initially deferred for each row execute function a2_proof_committed()',t);
  end loop;
end $$;
create constraint trigger a2_stop_intent_receipt after insert on workflow_stop_intents
  deferrable initially deferred for each row execute function a2_stop_intent_committed();
create constraint trigger a2_public_projection_receipt after insert or update on run_graph_public_projection
  deferrable initially deferred for each row execute function a2_public_projection_committed();
-- These are application transaction guards, not privilege escalation. Keep
-- invoker rights/search path and every existing authority/typed-writer guard.
` } as const

/** A sealed, unsubmitted review records its native-entry transition in the
 * cleanup graph source. Keep the original migration immutable for installed DBs. */
export const reviewCleanupEntryReceiptMigration = { version: 267203, sql: String.raw`
create or replace function a2_entry_committed() returns trigger language plpgsql as $$
declare item record; kind text;
begin
  if TG_TABLE_NAME='workflow_native_entries' then
    select e.phase,e.run_id,e.source_id,1::bigint as source_revision,e.source_digest into item
      from workflow_native_entries e where e.execution_id=NEW.execution_id;
    kind:='execution';
  else
    select e.phase,e.run_id,e.source_id,e.source_revision,e.source_digest into item
      from review_native_entries e where e.job_id=NEW.job_id;
    kind:=case when item.phase='not_submitted' then 'cleanup' else 'review' end;
  end if;
  if item.phase<>'reserved' and not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
    where s.run_id=item.run_id and s.source_kind=kind and s.source_id=item.source_id and s.source_revision=item.source_revision
      and s.source_digest=item.source_digest and s.first_sequence between 1 and h.head_sequence) then
    raise exception 'CURRENT_NATIVE_ENTRY_RECEIPT_REQUIRED' using errcode='P2602';
  end if;
  return NEW;
end $$;
` } as const
