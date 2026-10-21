/** CI scope extension; document classes, limits and existing references remain unchanged. */
export const jobArtifactStorageMigration = {
  version: 285202,
  sql: `
    alter table files add column job_execution_id text references job_executions(id);
    alter table files drop constraint files_scope_check;
    alter table files add constraint files_scope_check check ((case scope_kind
      when 'temporary' then job_execution_id is null and conversation_id is not null and
        retention_duration_seconds between 3600 and 31536000 and
        expires_at=created_at+retention_duration_seconds*interval '1 second' and
        (case chat_kind when 'operator' then operator_id is not null and agent_id is null and workspace_id is null and workflow_id is null and run_id is null and execution_id is null
          when 'agent' then operator_id is null and agent_id is not null and workspace_id is not null and workflow_id is not null and
            ((run_id is null and execution_id is null) or (run_id is not null and execution_id is not null)) else false end)
      when 'job_execution' then job_execution_id is not null and workspace_id is not null and
        chat_kind is null and conversation_id is null and operator_id is null and agent_id is null and workflow_id is null and run_id is null and execution_id is null and
        retention_duration_seconds between 3600 and 31536000 and expires_at=created_at+retention_duration_seconds*interval '1 second'
      when 'workflow_reference' then job_execution_id is null and chat_kind is null and conversation_id is null and operator_id is null and agent_id is null and workspace_id is not null and workflow_id is not null and run_id is null and execution_id is null and retention_duration_seconds is null and expires_at is null and state<>'expired'
      when 'workspace_reference' then job_execution_id is null and chat_kind is null and conversation_id is null and operator_id is null and agent_id is null and workspace_id is not null and workflow_id is null and run_id is null and execution_id is null and retention_duration_seconds is null and expires_at is null and state<>'expired'
      else false end) is true);
    alter table file_revisions drop constraint file_revisions_media_type_check;
    alter table file_revisions drop constraint file_revisions_origin_check;
    alter table file_revisions add constraint file_revisions_class_check check (
      (origin in ('upload','agent_output','agent_copy') and media_type in ('image/png','image/jpeg','image/webp','image/gif','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/markdown','application/zip')) or
      (origin='job_output' and media_type in ('text/plain','application/json','text/html','application/zip','application/gzip','application/octet-stream'))
    );
    create function job_artifact_file_identity() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        if old.scope_kind='job_execution' then raise exception 'Job artifact removal must retain its tombstone.'; end if;
        return old;
      end if;
      if new.scope_kind='job_execution' then
        perform 1 from job_executions where id=new.job_execution_id and workspace_id=new.workspace_id for share;
        if not found then raise exception 'Job artifact scope must match its actual workspace execution.'; end if;
      end if;
      if TG_OP='UPDATE' and (old.scope_kind='job_execution' or new.scope_kind='job_execution') then
        if row(old.file_id,old.owner_principal_id,old.current_revision_id,old.scope_kind,old.workspace_id,old.job_execution_id,old.created_at,old.retention_duration_seconds,old.expires_at)
          is distinct from row(new.file_id,new.owner_principal_id,new.current_revision_id,new.scope_kind,new.workspace_id,new.job_execution_id,new.created_at,new.retention_duration_seconds,new.expires_at) then
          raise exception 'Job artifact identity and accepted retention snapshot are immutable.';
        end if;
        if (old.state='removed' and new.state<>'removed') or (old.state='expired' and new.state not in ('expired','removed')) then
          raise exception 'Job artifact tombstones cannot be resurrected.';
        end if;
      end if;
      return new;
    end $$;
    create trigger job_artifact_file_identity before insert or update or delete on files for each row execute function job_artifact_file_identity();
    create function job_artifact_revision_scope() returns trigger language plpgsql as $$
    declare scope text;
    begin
      select scope_kind into scope from files where file_id=new.file_id;
      if (scope='job_execution') is distinct from (new.origin='job_output') then
        raise exception 'CI output revisions require explicit job execution scope.';
      end if;
      return new;
    end $$;
    create trigger job_artifact_revision_scope before insert on file_revisions for each row execute function job_artifact_revision_scope();
    create index file_job_execution_idx on files(workspace_id,job_execution_id,created_at,file_id) where scope_kind='job_execution';
    create unique index file_job_output_publication_idx on file_tool_publications(binding,(record->>'path')) where record->>'kind'='job_execution';
    create index file_job_expiry_idx on files(expires_at,file_id) where scope_kind='job_execution' and state in ('pending','ready');
  `,
} as const
