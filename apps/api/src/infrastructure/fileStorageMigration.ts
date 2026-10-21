/** FIL-03. Register this object in migrations.ts; do not renumber on integration. */
export const fileStorageMigration = {
  version: 273601,
  sql: `
    create table files (
      file_id text primary key,
      owner_principal_id text not null,
      current_revision_id text not null,
      scope_kind text not null,
      chat_kind text,
      operator_id text,
      conversation_id text references operator_conversations(id),
      agent_id text,
      workspace_id text,
      workflow_id text,
      run_id text,
      execution_id text,
      state text not null check (state in ('pending','ready','expired','removed')),
      created_at timestamptz not null,
      retention_duration_seconds integer,
      expires_at timestamptz,
      unique (file_id, owner_principal_id),
      constraint files_scope_check check ((case scope_kind
        when 'temporary' then
          conversation_id is not null and
          retention_duration_seconds between 3600 and 31536000 and
          expires_at = created_at + retention_duration_seconds * interval '1 second' and
          (case chat_kind
            when 'operator' then operator_id is not null and agent_id is null and
              workspace_id is null and workflow_id is null and run_id is null and execution_id is null
            when 'agent' then operator_id is null and agent_id is not null and
              workspace_id is not null and workflow_id is not null and
              ((run_id is null and execution_id is null) or (run_id is not null and execution_id is not null))
            else false end)
        when 'workflow_reference' then
          chat_kind is null and conversation_id is null and operator_id is null and agent_id is null and
          workspace_id is not null and workflow_id is not null and run_id is null and execution_id is null and
          retention_duration_seconds is null and expires_at is null and state <> 'expired'
        when 'workspace_reference' then
          chat_kind is null and conversation_id is null and operator_id is null and agent_id is null and
          workspace_id is not null and workflow_id is null and run_id is null and execution_id is null and
          retention_duration_seconds is null and expires_at is null and state <> 'expired'
        else false end) is true)
    );
    create index files_conversation_idx on files (conversation_id, created_at, file_id) where scope_kind='temporary';
    create index files_expiry_idx on files (expires_at, file_id) where scope_kind='temporary' and state in ('pending','ready');
    create index files_owner_idx on files (owner_principal_id, file_id);
    create index files_reference_idx on files (scope_kind, workspace_id, workflow_id, created_at, file_id)
      where scope_kind in ('workflow_reference','workspace_reference');

    create table file_revisions (
      revision_id text primary key,
      file_id text not null references files(file_id),
      filename text not null check (length(filename) between 1 and 255),
      media_type text not null check (media_type in (
        'image/png','image/jpeg','image/webp','image/gif','application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/markdown','application/zip')),
      byte_size bigint not null check (byte_size between 0 and 26214400),
      sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
      origin text not null check (origin in ('upload','agent_output','agent_copy')),
      created_at timestamptz not null,
      storage_key uuid not null unique,
      unique (file_id, revision_id)
    );
    alter table files add constraint files_head_fk foreign key (file_id, current_revision_id)
      references file_revisions(file_id, revision_id) deferrable initially deferred;

    create function file_revision_immutable() returns trigger language plpgsql as $$
    begin
      raise exception 'File revisions are immutable; retain revision metadata after byte removal.';
    end $$;
    create trigger file_revision_immutable before update or delete on file_revisions
      for each row execute function file_revision_immutable();

    create table file_allocations (
      allocation_id uuid primary key,
      owner_principal_id text not null,
      request_id text not null check (length(request_id) between 1 and 200),
      input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
      file_id text not null,
      revision_id text not null unique,
      state text not null check (state in ('allocated','staged','finalized','canceled')),
      created_at timestamptz not null,
      unique (owner_principal_id, request_id),
      foreign key (file_id, revision_id) references file_revisions(file_id, revision_id),
      foreign key (file_id, owner_principal_id) references files(file_id, owner_principal_id)
    );
  `,
} as const
