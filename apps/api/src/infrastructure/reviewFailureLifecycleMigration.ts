/** Terminal reviewer failures always retain a visible Stop/cleanup lifecycle. */
export const reviewFailureLifecycleMigration = {
  version: 170025,
  sql: `
    alter table runs add column stop_cause jsonb;
    create function graphql_keep_run_stop_cause() returns trigger
      language plpgsql security invoker as $$
    begin
      if TG_OP='UPDATE' and OLD.stop_cause is not null then
        NEW.stop_cause := OLD.stop_cause;
      end if;
      if NEW.stop_cause is not null then
        NEW.record := jsonb_set(NEW.record,'{stopCause}',NEW.stop_cause,true);
      else
        NEW.record := NEW.record - 'stopCause';
      end if;
      return NEW;
    end $$;
    create trigger graphql_run_stop_cause before insert or update on runs
      for each row execute function graphql_keep_run_stop_cause();

    -- Also update installations which already applied bundle v1 / migration 170024.
    create or replace function graphql_live_run_trigger() returns trigger
      language plpgsql security invoker as $$
    begin
      if TG_OP='INSERT' or (OLD.record->>'executionState',OLD.record->'stopCause')
        is distinct from (NEW.record->>'executionState',NEW.record->'stopCause') then
        perform graphql_record_live_run(NEW.id);
      end if;
      return NEW;
    end $$;
    create function graphql_live_cleanup_trigger() returns trigger
      language plpgsql security invoker as $$
    begin
      if TG_OP='INSERT' or OLD.pending is distinct from NEW.pending then
        perform graphql_record_live_run(NEW.run_id);
      end if;
      return NEW;
    end $$;
    create trigger graphql_live_cleanup after insert or update of pending on run_cleanup_intents
      for each row execute function graphql_live_cleanup_trigger();

    -- Repair the old post-delivery shortcut only when its exact saved lane is
    -- still unresolved. This is observation-only: submitted identity is retained.
    with reopened as (update review_jobs j set state='uncertain',revision=j.revision+1,updated_at=clock_timestamp(),
      record=(j.record - 'completedAt' - 'retryAfter') || jsonb_build_object('state','uncertain')
      from native_session_lanes l where j.state='completed' and j.record->'cleanup' is null
        and l.harness=j.record->>'provider' and l.native_session_id=j.record->>'nativeSessionId'
        and l.record->>'correlationId'=j.record->>'correlationId'
        and l.record->>'observedStatus' in ('busy','uncertain','disconnected')
        and (j.record->>'submittedAt' is not null or j.record->>'acknowledgedAt' is not null
          or j.record->>'providerTurnOrMessageId' is not null)
      returning j.id,j.execution_id,j.interaction_id,j.reviewer_agent_id,j.revision)
    insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select i.run_id,'backend','review_job_state',e.id,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','review','state','uncertain',
          'reviewJobId',j.id,'interactionId',i.id,'workflowNodeId',e.workflow_node_id,
          'agentId',e.agent_id,'requestingNodeId',requester.workflow_node_id,
          'revision',j.revision::text,'settlementReopened',true)
      from reopened j join durable_interactions i on i.id=j.interaction_id
      join harness_executions e on e.id=j.execution_id and e.run_id=i.run_id and e.agent_id=j.reviewer_agent_id
      join harness_executions requester on requester.id=i.execution_id and requester.run_id=i.run_id;

    -- Do not invent positive closure evidence for failures left by the old PR.
    -- They now enter both the bounded cleanup and independent Stop sweeps.
    update review_jobs set revision=revision+1,updated_at=clock_timestamp(),
      record=jsonb_set(record,'{cleanup}',jsonb_build_object(
        'nativeState','pending','credentialState','pending','interruptState','not_sent'),true)
      where state='failed' and (record->'cleanup' is null or record->'cleanup'='null'::jsonb);
  `,
} as const
