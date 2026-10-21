/** W09 adds only delegation/read records. Existing publication/allocation receipts remain canonical. */
export const artifactEdgeMigrationSql = `
create table if not exists file_artifact_edges (
  edge_id text primary key,
  command_id text not null,
  receiver_principal_id text not null,
  file_id text not null,
  revision_id text not null,
  record jsonb not null,
  unique(receiver_principal_id,command_id),
  foreign key(file_id,revision_id) references file_revisions(file_id,revision_id)
);
create table if not exists file_artifact_edge_reads (
  edge_id text not null references file_artifact_edges(edge_id),
  consumer_execution_id text not null,
  consumer_attempt_id text not null,
  read_at timestamptz not null
);
create function artifact_edge_fact_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Artifact edge pins and read provenance are append-only.';
end $$;
create trigger artifact_edge_immutable before update or delete on file_artifact_edges
  for each row execute function artifact_edge_fact_immutable();
create trigger artifact_edge_read_immutable before update or delete on file_artifact_edge_reads
  for each row execute function artifact_edge_fact_immutable();
`

export const artifactEdgeMigration = { version: 285201, sql: artifactEdgeMigrationSql }
