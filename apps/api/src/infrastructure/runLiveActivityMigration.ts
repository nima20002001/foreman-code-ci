/** State and its event commit together, including recovery/Stop and non-engine writers. */
export const runLiveActivityMigration = {
  version: 170024,
  sql: `
    create table if not exists run_activity (
      run_id text not null references runs(id) on delete cascade,
      sequence bigint generated always as identity,
      source text not null,
      kind text not null,
      harness_execution_id text,
      occurred_at timestamptz not null,
      payload jsonb not null,
      primary key (run_id, sequence)
    );
    create index if not exists run_activity_run_idx on run_activity (run_id, sequence);
    -- Pre-HAP installations may have the minimal execution table from migrations 1-3.
    alter table harness_executions add column if not exists run_id text;
    alter table harness_executions add column if not exists workflow_node_id text;
    alter table harness_executions add column if not exists agent_id text;
    alter table harness_executions add column if not exists attempt integer;
    update harness_executions set run_id=coalesce(run_id,record->>'runId'),
      workflow_node_id=coalesce(workflow_node_id,record->>'workflowNodeId'),
      agent_id=coalesce(agent_id,record->>'agentId'),
      attempt=coalesce(attempt,(record->>'attempt')::integer)
      where run_id is null or workflow_node_id is null or agent_id is null or attempt is null;
    create function graphql_record_live_run(p_id text) returns void
      language sql volatile security invoker as $$
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select r.id,'backend','run_state_changed',null,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','run','executionState',r.record->>'executionState')
      from runs r where r.id=p_id;
    $$;
    create function graphql_live_run_trigger() returns trigger
      language plpgsql security invoker as $$
    begin
      if TG_OP='INSERT' or (OLD.record->>'executionState') is distinct from (NEW.record->>'executionState') then
        perform graphql_record_live_run(NEW.id);
      end if;
      return NEW;
    end $$;
    create trigger graphql_live_run after insert or update of record on runs
      for each row execute function graphql_live_run_trigger();

    create function graphql_record_live_execution(p_id text) returns void
      language sql volatile security invoker as $$
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select e.run_id,'backend','node_state_changed',e.id,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','execution','workflowNodeId',e.workflow_node_id,
          'agentId',e.agent_id,'attempt',e.attempt,'state',e.record->>'state')
      from harness_executions e where e.id=p_id;
    $$;
    create function graphql_live_execution_trigger() returns trigger
      language plpgsql security invoker as $$
    begin
      if TG_OP='INSERT' or (OLD.record->>'state') is distinct from (NEW.record->>'state') then
        perform graphql_record_live_execution(NEW.id);
      end if;
      return NEW;
    end $$;
    create trigger graphql_live_execution after insert or update of record on harness_executions
      for each row execute function graphql_live_execution_trigger();

    create function graphql_record_live_interaction(p_id text) returns void
      language sql volatile security invoker as $$
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select i.run_id,'backend','interaction_delivery_state',e.id,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','interaction','interactionId',i.id,
          'workflowNodeId',e.workflow_node_id,'agentId',e.agent_id,
          'status',i.record->>'status','deliveryState',i.record->>'deliveryState',
          'handler',i.record->'approval'->>'handler',
          'reviewerAgentId',i.record->'approval'->>'designatedOrchestratorAgentId')
      from durable_interactions i join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
      where i.id=p_id;
    $$;
    create function graphql_live_interaction_trigger() returns trigger
      language plpgsql security invoker as $$
    begin
      if TG_OP='INSERT' or
        (OLD.record->>'status',OLD.record->>'deliveryState') is distinct from
        (NEW.record->>'status',NEW.record->>'deliveryState') then
        perform graphql_record_live_interaction(NEW.id);
      end if;
      return NEW;
    end $$;
    create trigger graphql_live_interaction after insert or update of record on durable_interactions
      for each row execute function graphql_live_interaction_trigger();

    create function graphql_record_live_review(p_id text) returns void
      language sql volatile security invoker as $$
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select i.run_id,'backend','review_job_state',e.id,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','review','reviewJobId',j.id,
          'workflowNodeId',e.workflow_node_id,'agentId',e.agent_id,'reviewerAgentId',j.reviewer_agent_id,
          'requestingNodeId',requester.workflow_node_id,'interactionId',i.id,
          'state',j.record->>'state','attempt',j.record->'attempt','revision',j.revision::text,
          'correlationId',j.record->>'correlationId','providerTurnOrMessageId',j.record->>'providerTurnOrMessageId',
          'cleanupComplete',j.record->'cleanup'->>'completedAt' is not null,
          'cleanupPending',j.record->'cleanup' is not null and j.record->'cleanup'->>'completedAt' is null)
      from review_jobs j join durable_interactions i on i.id=j.interaction_id
      join harness_executions e on e.id=j.execution_id and e.run_id=i.run_id and e.agent_id=j.reviewer_agent_id
      join harness_executions requester on requester.id=i.execution_id and requester.run_id=i.run_id
      where j.id=p_id;
    $$;
    create function graphql_live_review_trigger() returns trigger
      language plpgsql security invoker as $$
    begin
      if TG_OP='INSERT' or
        (OLD.record->>'state',OLD.record->>'attempt',OLD.record->>'providerTurnOrMessageId',OLD.record->'cleanup') is distinct from
        (NEW.record->>'state',NEW.record->>'attempt',NEW.record->>'providerTurnOrMessageId',NEW.record->'cleanup') then
        perform graphql_record_live_review(NEW.id);
      end if;
      return NEW;
    end $$;
    create trigger graphql_live_review after insert or update of record on review_jobs
      for each row execute function graphql_live_review_trigger();

    -- Migration runs under the repository's existing transaction/migration lock.
    -- Trigger DDL holds the write locks until this baseline and all DDL commit.
    -- Persist lifecycle facts only: never fabricate an active native tool for old history.
    select graphql_record_live_run(r.id) from runs r where r.execution_state in ('queued','running','waiting');
    select graphql_record_live_execution(e.id) from harness_executions e join runs r on r.id=e.run_id
      where r.execution_state in ('queued','running','waiting');
    select graphql_record_live_interaction(i.id) from durable_interactions i join runs r on r.id=i.run_id
      where r.execution_state in ('queued','running','waiting') and i.status not in ('delivered','canceled');
    select graphql_record_live_review(j.id) from review_jobs j join durable_interactions i on i.id=j.interaction_id
      join runs r on r.id=i.run_id where r.execution_state in ('queued','running','waiting');
  `,
} as const
