/** Additive cleanup authority/evidence. Original preparation and source facts remain. */
export const sourcePreparationReconciliationMigration = { version: 285003, sql: `
create table source_preparation_reconciliations (
 operation_id text primary key,
 reconciliation_id uuid not null unique,
 workspace_id text not null references workspaces(id),
 principal_id text not null references management_principals(id),
 command_id text not null,
 status text not null check(status in ('reconciling','closed')),
 owner jsonb not null,
 closure jsonb,
 created_at timestamptz not null default now(),
 check((status='closed')=(closure is not null))
);
` } as const
