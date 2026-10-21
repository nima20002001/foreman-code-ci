/** Run-owned delivery receipts and mailbox reservations. Native evidence stays in
 * the existing execution/session stores; these rows never authorize native work. */
export const workflowControlsMigration = { version: 2026102106, sql: String.raw`
create table run_chat_commands (
  id text primary key,
  sequence bigint generated always as identity unique,
  command_id text not null,
  principal_id text not null,
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  workflow_node_id text not null,
  target jsonb not null,
  target_key text not null,
  work jsonb,
  kind text not null check(kind in ('delivery','stop','cancel')),
  operation text not null check(operation in ('steer','input','interrupt','stop','consultation','cancel')),
  input_digest text not null,
  request jsonb not null,
  native_prompt text,
  native_target jsonb,
  state text not null check(state in ('queued','submitting','accepted','completed','failed','canceled','unknown','recorded','settling')),
  receipt jsonb not null,
  continuation_id text,
  consultation_id text,
  delivered_execution jsonb,
  revision bigint not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(principal_id,command_id),
  check(target->>'kind' in ('workflow_execution','workflow_coordinator')),
  check(target #>> '{agent,workflowNodeId}' is not distinct from workflow_node_id),
  check(receipt->'target' is not distinct from target),
  check(receipt->>'commandId' is not distinct from command_id),
  check(kind<>'delivery' or receipt->>'id'=id),
  check(work is null or work->>'runId'=run_id),
  check(delivered_execution is null or delivered_execution->>'runId'=run_id)
);
create index run_chat_target_page on run_chat_commands(run_id,target_key,sequence desc);
create index run_chat_work_queue on run_chat_commands(run_id,work,sequence) where kind='delivery' and state='queued';
create index run_chat_pending on run_chat_commands(run_id,sequence) where state in ('queued','submitting','settling','unknown');

create table run_control_continuations (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  previous_execution_id text not null references harness_executions(id),
  work jsonb not null,
  delivery_id text not null references run_chat_commands(id),
  reserved_successor_execution_id text not null unique,
  successor_execution_id text references harness_executions(id) deferrable initially deferred,
  state text not null check(state in ('reserved','waiting_settlement','admitted','failed','canceled','unknown')),
  native_evidence jsonb,
  record jsonb not null,
  unique(run_id,previous_execution_id),
  check(record->>'id'=id),
  check(record->>'state'=state),
  check(record->'work'=work),
  check(work->>'runId'=run_id),
  check(record #>> '{previousExecution,executionId}'=previous_execution_id),
  check(record #>> '{previousExecution,workflowVersionId}'=workflow_version_id),
  check(state<>'admitted' or successor_execution_id is not null),
  check(successor_execution_id is null or state in ('admitted','failed')),
  check(successor_execution_id is null or successor_execution_id=reserved_successor_execution_id),
  check(successor_execution_id is null or native_evidence is not null),
  check(native_evidence is null or native_evidence->>'id'=previous_execution_id)
);
create unique index run_control_one_pending_work on run_control_continuations(run_id,work)
  where state in ('reserved','waiting_settlement','unknown');
alter table run_chat_commands add constraint run_chat_continuation
  foreign key(continuation_id) references run_control_continuations(id) deferrable initially deferred;

create table run_coordinator_mailboxes (
  run_id text not null references runs(id) on delete cascade,
  waiting_activation_id text not null,
  group_id text not null unique references run_hierarchy_groups(group_id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  workflow_node_id text not null,
  native_session_id text not null,
  agent jsonb not null,
  source_execution jsonb not null,
  state text not null check(state in ('idle','consultation','graph','canceled')),
  active_consultation_id text,
  reserved_next_consultation_id text,
  primary key(run_id,waiting_activation_id),
  foreign key(run_id,waiting_activation_id) references run_work_activations(run_id,activation_id) deferrable initially deferred,
  check((state='consultation')=(active_consultation_id is not null)),
  check(agent->>'workflowNodeId'=workflow_node_id),
  check(source_execution->>'runId'=run_id),
  check(source_execution->>'workflowVersionId'=workflow_version_id)
);
create table run_coordinator_consultations (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  waiting_activation_id text not null,
  command_id text not null unique references run_chat_commands(id),
  binding jsonb not null,
  state text not null check(state in ('admitted','active','settling','completed','failed','canceled','unknown')),
  native_target jsonb,
  native_turn_id text,
  native_evidence jsonb,
  preparation_error_code text,
  browser_input jsonb,
  browser_state text check(browser_state in ('preparing','ready','unavailable','releasing','released')),
  browser_session_id text,
  browser_unavailable jsonb,
  browser_release_reason text check(browser_release_reason in ('terminal','stop')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(run_id,id),
  foreign key(run_id,waiting_activation_id) references run_coordinator_mailboxes(run_id,waiting_activation_id)
    on delete cascade deferrable initially deferred,
  check(binding->>'consultationId'=id),
  check(binding->>'runId'=run_id),
  check(binding->>'waitingActivationId'=waiting_activation_id),
  check(binding->>'purpose'='consultation')
);
alter table run_chat_commands add constraint run_chat_consultation
  foreign key(consultation_id) references run_coordinator_consultations(id) deferrable initially deferred;
alter table run_coordinator_mailboxes add constraint coordinator_active_consultation
  foreign key(active_consultation_id) references run_coordinator_consultations(id) deferrable initially deferred;
alter table run_coordinator_mailboxes add constraint coordinator_next_consultation
  foreign key(reserved_next_consultation_id) references run_coordinator_consultations(id) deferrable initially deferred;
create index coordinator_consultation_history on run_coordinator_consultations(run_id,waiting_activation_id,created_at,id);

create table run_coordinator_native_events (
  consultation_id text not null,
  run_id text not null references runs(id) on delete cascade,
  sequence bigint generated always as identity primary key,
  source_id text not null,
  record jsonb not null,
  created_at timestamptz not null,
  unique(consultation_id,source_id),
  foreign key(run_id,consultation_id) references run_coordinator_consultations(run_id,id) on delete cascade
);
create index run_coordinator_native_events_page on run_coordinator_native_events(consultation_id,sequence desc);
create table run_coordinator_native_history (
  consultation_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  revision bigint not null check(revision>=0),
  history jsonb not null,
  observed_at timestamptz not null,
  foreign key(run_id,consultation_id) references run_coordinator_consultations(run_id,id) on delete cascade
);
alter table worker_credential_bindings drop constraint worker_credential_bindings_purpose_check;
alter table worker_credential_bindings add constraint worker_credential_bindings_purpose_check
  check(purpose in ('workflow','reviewer','consultation'));
alter table worker_credential_bindings add column consultation_id text references run_coordinator_consultations(id),
  add column consultation_binding jsonb,
  add constraint worker_consultation_binding_shape check (
    ((purpose='consultation' and consultation_id is not null and consultation_binding is not null)
      or (purpose<>'consultation' and consultation_id is null and consultation_binding is null))
    and (consultation_binding is null or (consultation_binding->>'consultationId'=consultation_id
      and consultation_binding->>'runId'=run_id and consultation_binding->>'purpose'='consultation'))
  );
create index worker_consultation_credentials on worker_credential_bindings(consultation_id,principal_id)
  where purpose='consultation';

create function protect_run_chat_identity() returns trigger language plpgsql as $$
begin
  if tg_table_name='run_chat_commands' then
    if to_jsonb(new)-array['state','receipt','native_target','continuation_id','consultation_id','delivered_execution','revision','updated_at']
      is distinct from to_jsonb(old)-array['state','receipt','native_target','continuation_id','consultation_id','delivered_execution','revision','updated_at']
      or old.native_target is not null and new.native_target is distinct from old.native_target
      or old.continuation_id is not null and new.continuation_id is distinct from old.continuation_id
      or old.consultation_id is not null and new.consultation_id is distinct from old.consultation_id
      or old.delivered_execution is not null and new.delivered_execution is distinct from old.delivered_execution
      or old.state in ('completed','failed','canceled') and new is distinct from old then
      raise exception 'RUN_CHAT_COMMAND_IDENTITY_CONFLICT';
    end if;
  elsif tg_table_name='run_control_continuations' then
    if to_jsonb(new)-array['state','record','successor_execution_id','native_evidence']
      is distinct from to_jsonb(old)-array['state','record','successor_execution_id','native_evidence']
      or new.record-array['state','successorExecution','errorCode','updatedAt']
        is distinct from old.record-array['state','successorExecution','errorCode','updatedAt']
      or old.native_evidence is not null and new.native_evidence is distinct from old.native_evidence
      or old.successor_execution_id is not null and new.successor_execution_id is distinct from old.successor_execution_id
      or old.state='admitted' and new.state not in ('admitted','failed')
      or old.state in ('failed','canceled') and new is distinct from old then
      raise exception 'RUN_CONTROL_CONTINUATION_IDENTITY_CONFLICT';
    end if;
  elsif tg_table_name='run_coordinator_mailboxes' then
    if to_jsonb(new)-array['state','active_consultation_id','reserved_next_consultation_id'] is distinct from to_jsonb(old)-array['state','active_consultation_id','reserved_next_consultation_id']
      or old.state in ('graph','canceled') and new is distinct from old then
      raise exception 'COORDINATOR_MAILBOX_IDENTITY_CONFLICT';
    end if;
  elsif tg_table_name='run_coordinator_consultations' then
    if to_jsonb(new)-array['state','native_target','native_turn_id','native_evidence','preparation_error_code','updated_at',
        'browser_input','browser_state','browser_session_id','browser_unavailable','browser_release_reason']
      is distinct from to_jsonb(old)-array['state','native_target','native_turn_id','native_evidence','preparation_error_code','updated_at',
        'browser_input','browser_state','browser_session_id','browser_unavailable','browser_release_reason']
      or old.native_target is not null and new.native_target is distinct from old.native_target
      or old.native_turn_id is not null and new.native_turn_id is distinct from old.native_turn_id
      or old.native_evidence is not null and new.native_evidence is distinct from old.native_evidence
      or old.preparation_error_code is not null and new.preparation_error_code is distinct from old.preparation_error_code
      or old.browser_input is not null and new.browser_input is distinct from old.browser_input
      or old.browser_session_id is not null and new.browser_session_id is distinct from old.browser_session_id
      or old.state in ('completed','failed','canceled')
        and to_jsonb(new)-array['browser_input','browser_state','browser_session_id','browser_unavailable','browser_release_reason','updated_at']
          is distinct from to_jsonb(old)-array['browser_input','browser_state','browser_session_id','browser_unavailable','browser_release_reason','updated_at'] then
      raise exception 'COORDINATOR_CONSULTATION_IDENTITY_CONFLICT';
    end if;
  elsif tg_table_name='run_coordinator_native_events' and new is distinct from old then
    raise exception 'COORDINATOR_NATIVE_EVIDENCE_IMMUTABLE';
  elsif tg_table_name='run_coordinator_native_history' then
    if new.consultation_id is distinct from old.consultation_id or new.run_id is distinct from old.run_id
      or new.revision<old.revision or new.revision=old.revision and new.history is distinct from old.history then
      raise exception 'COORDINATOR_NATIVE_HISTORY_CONFLICT';
    end if;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['run_chat_commands','run_control_continuations','run_coordinator_mailboxes','run_coordinator_consultations',
    'run_coordinator_native_events','run_coordinator_native_history'] loop
    execute format('create trigger %I before update on %I for each row execute function protect_run_chat_identity()',t||'_identity',t);
    execute format('create constraint trigger %I after delete on %I deferrable initially deferred for each row execute function assert_work_evidence_retention()',t||'_retention',t);
    execute format('create trigger %I before truncate on %I for each statement execute function reject_work_evidence_truncate()',t||'_no_truncate',t);
  end loop;
end $$;
` } as const
