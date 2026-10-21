/** Additive W09-A metadata; historical Runs/locations are not synthesized. */
export const sourceMetadataMigration = { version: 285001, sql: `
create table source_approvals (
 approved_source_id uuid primary key, snapshot_id uuid not null unique,
 workspace_id text not null references workspaces(id), owner_principal_id text not null references management_principals(id),
 requested_by text not null references management_principals(id), command_id text not null, input_hash text not null,
 state text not null check(state in ('capturing','approved','failed')), origin jsonb not null, request jsonb not null,
 unique(requested_by,command_id), created_at timestamptz not null default now()
);
create table source_snapshots (
 snapshot_id uuid primary key references source_approvals(snapshot_id), approved_source_id uuid not null references source_approvals(approved_source_id),
 workspace_id text not null references workspaces(id), manifest_digest text not null check(manifest_digest ~ '^[a-f0-9]{64}$'),
 record jsonb not null, availability text not null default 'retained' check(availability in ('retained','unavailable')),
 unique(workspace_id,snapshot_id), unique(approved_source_id,snapshot_id,manifest_digest)
);
create table source_root_catalog (
 root_id uuid primary key, workspace_id text not null references workspaces(id), scope_hash text not null unique,
 current_binding_revision bigint not null default 0 check(current_binding_revision>=0)
);
create table source_root_bindings (
 root_id uuid not null references source_root_catalog(root_id), binding_revision bigint not null check(binding_revision>0),
 workspace_id text not null, snapshot_id uuid not null, record jsonb not null,
 primary key(root_id,binding_revision), foreign key(workspace_id,snapshot_id) references source_snapshots(workspace_id,snapshot_id)
);
create table source_storage_reservations (
 reservation_id uuid primary key, scope_id text not null, owner_kind text not null check(owner_kind in ('capture','transfer','materialization')),
 owner_id text not null, reserved_bytes bigint not null check(reserved_bytes>=0),
 state text not null check(state in ('preparing','retained','owned','uncertain','reclaimed')),
 record jsonb not null, unique(owner_kind,owner_id)
);
create index source_storage_reservations_scope_idx on source_storage_reservations(scope_id,state);
create table source_execution_materializations (
 materialization_id uuid primary key, workspace_id text not null references workspaces(id), execution_id text not null,
 attempt_id text not null, operation_id text not null, root_id uuid not null, binding_revision bigint not null,
 reservation_id uuid not null references source_storage_reservations(reservation_id), record jsonb not null,
 state text not null check(state in ('prepared','running','uncertain','closed')), unique(execution_id,attempt_id), unique(operation_id),
 foreign key(root_id,binding_revision) references source_root_bindings(root_id,binding_revision)
);
create function source_fact_immutable() returns trigger language plpgsql as $$
begin raise exception 'Accepted source snapshots and root binding facts are immutable.'; end $$;
create trigger source_roots_immutable before update or delete on source_root_bindings for each row execute function source_fact_immutable();
create function source_snapshot_immutable() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or new.snapshot_id<>old.snapshot_id or new.approved_source_id<>old.approved_source_id
 or new.workspace_id<>old.workspace_id or new.manifest_digest<>old.manifest_digest or new.record<>old.record
 or (old.availability='unavailable' and new.availability<>'unavailable') then
 raise exception 'Source facts cannot be changed or resurrected.'; end if; return new;
end $$;
create trigger source_snapshots_immutable before update or delete on source_snapshots for each row execute function source_snapshot_immutable();
` } as const
