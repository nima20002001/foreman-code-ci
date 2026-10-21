/** Register once AFTER G1 migrations 250001/250002. The terminal allocates the
 * Stage-B migration number; this module deliberately does not invent one. */
export const wave25ApprovalMigrationSql = `
  alter table durable_interactions
    add column approval_relationship_id text,
    add column approval_reviewer_execution_id text references harness_executions(id);
  alter table review_jobs
    add column approval_connection_generation bigint check(approval_connection_generation>=0),
    add column approval_native_evidence jsonb;
  alter table interaction_delivery_attempts
    add column approval_write_started_at timestamptz,
    add column approval_connection_generation bigint check(approval_connection_generation>=0);
  alter table interaction_graph_resumes
    add column approval_dispatch_started_at timestamptz,
    add column approval_native_ack_id text,
    add column approval_native_ack_source jsonb;
  alter table worker_credential_bindings
    add column approval_native_session_id text,
    add column approval_review_job_id text references review_jobs(id),
    add column approval_review_lease_fence bigint check(approval_review_lease_fence>=0),
    add column approval_connection_generation bigint check(approval_connection_generation>=0);

  -- Existing legacy records, native identities and checkpoints are not rewritten.
  -- The v2 writer has to bind the exact native session when issuing a reviewer token.
  create function wave25_approval_no_downgrade() returns trigger language plpgsql as $$
  declare old_graph jsonb; new_graph jsonb;
  begin
    if TG_TABLE_NAME='graph_drafts' then
      old_graph=OLD.record->'graph'; new_graph=NEW.record->'graph';
    else old_graph=OLD.record; new_graph=NEW.record; end if;
    if old_graph->>'executionSemanticsVersion'='2' and
      (new_graph->>'executionSemanticsVersion' is distinct from '2'
       or not (new_graph ? 'entryNodeId')
       or exists(select 1 from jsonb_array_elements(new_graph->'edges') e
         where e->>'kind' is null or e->>'kind' not in ('execution','approval'))) then
      raise exception 'APPROVAL_OLDER_WRITER_REJECTED' using errcode='PGA01';
    end if;
    if new_graph->>'executionSemanticsVersion'='2' and
      ((old_graph->'approval') is distinct from (new_graph->'approval') or
       (select coalesce(jsonb_agg(e order by e->>'id'),'[]'::jsonb) from jsonb_array_elements(old_graph->'edges') e where e->>'kind'='approval')
       is distinct from
       (select coalesce(jsonb_agg(e order by e->>'id'),'[]'::jsonb) from jsonb_array_elements(new_graph->'edges') e where e->>'kind'='approval'))
      and current_setting('graphql.approval_writer',true) is distinct from 'v2' then
      raise exception 'APPROVAL_TYPED_WRITER_REQUIRED' using errcode='PGA04';
    end if;
    return NEW;
  end $$;
  do $$ begin
    if exists (select 1 from information_schema.columns
      where table_schema=current_schema() and table_name='workflows' and column_name='record') then
      create trigger wave25_approval_workflow_writer before update of record on workflows
        for each row execute function wave25_approval_no_downgrade();
    end if;
  end $$;
  do $$ begin
    if exists (select 1 from information_schema.columns
      where table_schema=current_schema() and table_name='graph_drafts' and column_name='record') then
      create trigger wave25_approval_draft_writer before update of record on graph_drafts
        for each row execute function wave25_approval_no_downgrade();
    end if;
  end $$;

  create function wave25_approval_immutable_version() returns trigger language plpgsql as $$
  begin
    if OLD.execution_semantics_version=2 and NEW.record is distinct from OLD.record then
      raise exception 'APPROVAL_ACCEPTED_VERSION_IMMUTABLE' using errcode='PGA02';
    end if;
    return NEW;
  end $$;
  create trigger wave25_approval_version_writer before update on workflow_versions
    for each row execute function wave25_approval_immutable_version();

  -- Defense in depth for an old/unconverted writer: v2 semantic changes cannot
  -- commit without their same-transaction G1 source receipt. Lease renewal alone
  -- is not semantic progress. No triggers manufacture graph events or outcomes.
  create function wave25_approval_requires_publication() returns trigger language plpgsql as $$
  declare target_run text; target_id text; target_revision bigint; kinds text[];
  begin
    if TG_TABLE_NAME='durable_interactions' then
      target_run=NEW.run_id; target_id=NEW.id; target_revision=NEW.revision;
      kinds=array['interaction','delivery','native_event'];
      if TG_OP='UPDATE' and NEW.record is not distinct from OLD.record and NEW.status=OLD.status then return NEW; end if;
    else
      select run_id into target_run from durable_interactions where id=NEW.interaction_id;
      target_id=NEW.id; target_revision=NEW.revision; kinds=array['review','cleanup','native_event'];
      if TG_OP='UPDATE' and NEW.state=OLD.state and
        (NEW.record - array['leaseOwner','leaseToken','leaseExpiresAt','updatedAt','retryAfter']) is not distinct from
        (OLD.record - array['leaseOwner','leaseToken','leaseExpiresAt','updatedAt','retryAfter']) then return NEW; end if;
    end if;
    if not exists(select 1 from runs r join workflow_versions v on v.id=r.workflow_version_id
      where r.id=target_run and v.execution_semantics_version=2) then return NEW; end if;
    if not exists(select 1 from run_graph_sources s join run_graph_batches b
        on b.run_id=s.run_id and b.sequence=s.first_sequence
      where s.run_id=target_run and s.source_id=target_id and s.source_revision=target_revision
        and s.source_kind=any(kinds) and b.publication_xid=pg_current_xact_id()) then
      raise exception 'APPROVAL_ATOMIC_PUBLICATION_REQUIRED' using errcode='PGA03';
    end if;
    return NEW;
  end $$;
  create constraint trigger wave25_approval_interaction_publication after insert or update on durable_interactions
    deferrable initially deferred for each row execute function wave25_approval_requires_publication();
  create constraint trigger wave25_approval_review_publication after insert or update on review_jobs
    deferrable initially deferred for each row execute function wave25_approval_requires_publication();
  create function wave25_approval_generation_monotonic() returns trigger language plpgsql as $$
  begin
    if (NEW.record->>'connectionGeneration')::bigint < (OLD.record->>'connectionGeneration')::bigint
      and exists(select 1 from execution_native_sessions s join harness_executions e on e.id=s.execution_id
        join runs r on r.id=e.run_id join workflow_versions v on v.id=r.workflow_version_id
        where v.execution_semantics_version=2 and s.reference->>'nativeSessionId'=OLD.native_session_id
          and s.reference->>'harness'=OLD.harness) then
      raise exception 'GRAPH_STALE_GENERATION' using errcode='PGA05';
    end if;
    return NEW;
  end $$;
  create trigger wave25_approval_generation_guard before update on native_session_lanes
    for each row execute function wave25_approval_generation_monotonic();
`
