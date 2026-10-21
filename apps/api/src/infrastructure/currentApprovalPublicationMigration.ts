/** V3 approval rows require the same-transaction graph source as their writers. */
export const currentApprovalPublicationMigration = { version: 267202, sql: `
  create function current_approval_requires_publication() returns trigger language plpgsql as $$
  declare target_run text; target_id text; target_revision bigint; kinds text[];
  begin
    if TG_TABLE_NAME='durable_interactions' then
      target_run=NEW.run_id; target_id=NEW.id; target_revision=NEW.revision;
      kinds=array['interaction','delivery','native_event'];
      if TG_OP='UPDATE' and NEW.record is not distinct from OLD.record and NEW.status=OLD.status
        and NEW.revision=OLD.revision then return NEW; end if;
    else
      select run_id into target_run from durable_interactions where id=NEW.interaction_id;
      target_id=NEW.id; target_revision=NEW.revision; kinds=array['review','cleanup','native_event'];
      if TG_OP='UPDATE' and NEW.state=OLD.state and
        (NEW.record - array['leaseOwner','leaseToken','leaseExpiresAt','updatedAt','retryAfter']) is not distinct from
        (OLD.record - array['leaseOwner','leaseToken','leaseExpiresAt','updatedAt','retryAfter']) then return NEW; end if;
    end if;
    if not exists(select 1 from runs r join workflow_versions v on v.id=r.workflow_version_id
      where r.id=target_run and v.execution_semantics_version=3) then return NEW; end if;
    if not exists(select 1 from run_graph_sources s join run_graph_batches b
        on b.run_id=s.run_id and b.sequence=s.first_sequence
      where s.run_id=target_run and s.source_id=target_id and s.source_revision=target_revision
        and s.source_kind=any(kinds) and b.publication_xid=pg_current_xact_id()) then
      raise exception 'APPROVAL_ATOMIC_PUBLICATION_REQUIRED' using errcode='PGA03';
    end if;
    return NEW;
  end $$;
  create constraint trigger current_approval_interaction_publication after insert or update on durable_interactions
    deferrable initially deferred for each row execute function current_approval_requires_publication();
  create constraint trigger current_approval_review_publication after insert or update on review_jobs
    deferrable initially deferred for each row execute function current_approval_requires_publication();
` } as const
