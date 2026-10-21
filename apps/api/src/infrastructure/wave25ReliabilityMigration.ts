/** A1 v3 additive reliability delta. Register AFTER 250001; no native/projector hooks. */
export const wave25ReliabilityMigration = {
  version: 250002,
  sql: `
    -- Stop intent is distinct from ordinary completion cleanup and never cleared.
    alter table runs add column stop_requested_at timestamptz;
    create function graphql_run_reliability_fence() returns trigger
      language plpgsql security invoker as $$
    begin
      if OLD.stop_requested_at is not null and NEW.stop_requested_at is distinct from OLD.stop_requested_at then
        raise exception using errcode='PGR01', message='A durable Stop fence cannot be cleared or replaced.';
      end if;
      -- Existing v1 behavior remains untouched. No timestamp/transport inference.
      if OLD.record->>'executionSemanticsVersion'='2' then
        if NEW.record->>'executionSemanticsVersion' is distinct from '2'
          or NEW.workflow_version_id is distinct from OLD.workflow_version_id
          or NEW.record->>'workflowVersionId' is distinct from OLD.record->>'workflowVersionId'
          or NEW.record->>'executionState' is distinct from NEW.execution_state then
          raise exception using errcode='PGR02', message='Immutable Run semantics and lifecycle columns must agree.';
        end if;
        if OLD.execution_state='completed' and
          (NEW.execution_state is distinct from OLD.execution_state or
           NEW.record->>'outcome' is distinct from OLD.record->>'outcome' or
           NEW.record->'result' is distinct from OLD.record->'result' or
           NEW.record->>'finishedAt' is distinct from OLD.record->>'finishedAt') then
          raise exception using errcode='PGR02', message='A terminal Run cannot be rewritten or resumed.';
        end if;
        if NEW.stop_requested_at is not null and NEW.execution_state is distinct from OLD.execution_state
          and NEW.execution_state not in ('completed','interrupted') then
          raise exception using errcode='PGR01', message='Stopped work cannot resume.';
        end if;
        if NEW.stop_requested_at is not null and OLD.execution_state<>'completed'
          and NEW.execution_state='completed' and NEW.record->>'outcome'='succeeded' then
          raise exception using errcode='PGR01', message='Stop won before completion; late evidence cannot commit Run success.';
        end if;
      end if;
      return NEW;
    end $$;
    create trigger graphql_run_reliability_fence before update on runs
      for each row execute function graphql_run_reliability_fence();

    -- Receipts only, not a queue, runtime owner, occurrence table or native dispatcher.
    -- Retain with source receipts even when public journal history expires.
    create table run_graph_effects (
      run_id text not null references run_graph_heads(run_id) on delete cascade,
      effect_kind text not null check (effect_kind in
        ('execution.launch','result.accept','route.resolve','input.bind','approval.decide',
         'approval.deliver','graph.resume','review.settle','run.stop')),
      entity_id text not null check (octet_length(entity_id)<=200),
      effect_digest text not null check (effect_digest ~ '^sha256:[0-9a-f]{64}$'),
      semantic_digest text not null check (semantic_digest ~ '^sha256:[0-9a-f]{64}$'),
      first_sequence bigint not null check (first_sequence>0),
      primary key (run_id,effect_kind,entity_id)
    );
  `,
} as const
