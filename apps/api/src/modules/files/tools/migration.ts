/** FIL-05. Apply after fileStorageMigration (273601). See docs/FIL-05-TOOLS.md for registration. */
export const fileToolsMigration = {
  version: 273605,
  sql: `
    create table file_tool_sessions (
      token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
      record jsonb not null,
      expires_at timestamptz not null,
      revoked_at timestamptz
    );
    create table file_tool_artifacts (
      artifact_id uuid primary key,
      binding text not null check (binding ~ '^[a-f0-9]{64}$'),
      record jsonb not null,
      check ((record->>'artifactId'=artifact_id::text and record->>'binding'=binding
        and record->>'state' in ('writing','complete','failed')
        and record->>'writeId' is not null
        and (record->>'state'<>'complete' or jsonb_typeof(record->'snapshot')='object')) is true)
    );
    create index file_tool_artifacts_binding_idx on file_tool_artifacts(binding);
    create table file_tool_copy_receipts (
      owner_principal_id text not null,
      command_id text not null check (length(command_id) between 8 and 200),
      record jsonb not null,
      primary key(owner_principal_id,command_id)
    );
    create table file_tool_publications (
      owner_principal_id text not null,
      request_id text not null,
      binding text not null check (binding ~ '^[a-f0-9]{64}$'),
      file_id text not null,
      revision_id text not null,
      record jsonb not null,
      primary key(owner_principal_id,request_id),
      unique(file_id,revision_id),
      foreign key(file_id,revision_id) references file_revisions(file_id,revision_id),
      foreign key(file_id,owner_principal_id) references files(file_id,owner_principal_id),
      foreign key(owner_principal_id,request_id) references file_allocations(owner_principal_id,request_id)
    );
    create index file_tool_publications_binding_idx on file_tool_publications(binding);
    create table file_tool_read_provenance (
      id bigint generated always as identity primary key,
      binding text not null,
      run_id text not null,
      execution_id text not null,
      file_id text not null,
      revision_id text not null,
      read_at timestamptz not null,
      foreign key(file_id,revision_id) references file_revisions(file_id,revision_id)
    );
    create index file_tool_read_provenance_run_idx on file_tool_read_provenance(run_id,execution_id);
    create function file_tool_fact_immutable() returns trigger language plpgsql as $$
    begin
      raise exception 'File tool receipts, turn links and read provenance are append-only.';
    end $$;
    create trigger file_tool_copy_immutable before update or delete on file_tool_copy_receipts
      for each row execute function file_tool_fact_immutable();
    create trigger file_tool_publication_immutable before update or delete on file_tool_publications
      for each row execute function file_tool_fact_immutable();
    create trigger file_tool_read_immutable before update or delete on file_tool_read_provenance
      for each row execute function file_tool_fact_immutable();
  `,
} as const
