/** Generic approved workspace roots, independent of source snapshots/Run/Agent. */
export const workspaceRootPoliciesMigration = { version: 285002, sql: `
create table workspace_root_host_configurations (
 host_scope text not null, configuration_revision bigint not null check(configuration_revision>0),
 main_id uuid not null, application_installation_id uuid not null, record jsonb not null, digest text not null,
 primary key(host_scope,configuration_revision)
);
create table workspace_root_host_configuration_heads (
 host_scope text primary key, configuration_revision bigint not null,
 foreign key(host_scope,configuration_revision) references workspace_root_host_configurations(host_scope,configuration_revision)
);
create table workspace_root_policies (
 root_policy_id uuid not null, root_policy_revision bigint not null check(root_policy_revision>0),
 workspace_id text not null references workspaces(id), host_scope text not null, location_revision bigint not null,
 record jsonb not null, revoked_at timestamptz,
 primary key(root_policy_id,root_policy_revision)
);
create table workspace_root_policy_heads (
 workspace_id text not null references workspaces(id), host_scope text not null, root_policy_id uuid not null,
 root_policy_revision bigint not null, primary key(workspace_id,host_scope),
 foreign key(root_policy_id,root_policy_revision) references workspace_root_policies(root_policy_id,root_policy_revision)
);
create function workspace_root_fact_immutable() returns trigger language plpgsql as $$
begin raise exception 'Approved root configuration facts are immutable.'; end $$;
create trigger workspace_root_config_immutable before update or delete on workspace_root_host_configurations for each row execute function workspace_root_fact_immutable();
create function workspace_root_policy_immutable() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or new.record<>old.record or new.root_policy_id<>old.root_policy_id or new.root_policy_revision<>old.root_policy_revision
 or new.workspace_id<>old.workspace_id or new.host_scope<>old.host_scope or new.location_revision<>old.location_revision
 or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then raise exception 'Approved root facts cannot change or resurrect.'; end if; return new;
end $$;
create trigger workspace_root_policy_immutable before update or delete on workspace_root_policies for each row execute function workspace_root_policy_immutable();
` } as const
