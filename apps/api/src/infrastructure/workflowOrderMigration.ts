export const workflowOrderMigration = { version: 2026101214, sql: `
alter table workspaces add column workflow_order_revision bigint not null default 0
  check (workflow_order_revision >= 0);
alter table workflows add column order_position bigint;

with positions as (
  select id, row_number() over (partition by workspace_id order by id) as position from workflows
)
update workflows set order_position = positions.position from positions where workflows.id = positions.id;

alter table workflows alter column order_position set not null;
alter table workflows add constraint workflow_order_position_positive check (order_position > 0);
alter table workflows add constraint workflow_order_position_unique
  unique (workspace_id, order_position) deferrable initially immediate;

create function prepare_workflow_order() returns trigger language plpgsql as $$
declare
  workspace_ids text[];
  workspace_id text;
begin
  if TG_OP = 'UPDATE' then
    if NEW.workspace_id = OLD.workspace_id
      and (NEW.archived_at is null) = (OLD.archived_at is null) then
      return NEW;
    end if;
    workspace_ids := array[OLD.workspace_id, NEW.workspace_id];
  elsif TG_OP = 'DELETE' then
    workspace_ids := array[OLD.workspace_id];
  else
    workspace_ids := array[NEW.workspace_id];
  end if;

  -- Fixture and restore inserts share the same workspace lock as product writes.
  for workspace_id in select distinct id from unnest(workspace_ids) as ids(id) order by id loop
    perform pg_advisory_xact_lock(hashtext('admission:workspace:' || workspace_id));
  end loop;
  perform 1 from workspaces where id = any(workspace_ids) order by id for update;
  if TG_OP = 'INSERT' or (TG_OP = 'UPDATE' and NEW.workspace_id <> OLD.workspace_id) then
    select coalesce(max(order_position), 0) + 1 into NEW.order_position
      from workflows where workflows.workspace_id = NEW.workspace_id;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;

create function revise_workflow_order() returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    update workspaces set workflow_order_revision = workflow_order_revision + 1 where id = NEW.workspace_id;
  elsif TG_OP = 'DELETE' then
    update workspaces set workflow_order_revision = workflow_order_revision + 1 where id = OLD.workspace_id;
  elsif NEW.workspace_id <> OLD.workspace_id
    or (NEW.archived_at is null) <> (OLD.archived_at is null) then
    update workspaces set workflow_order_revision = workflow_order_revision + 1
      where id in (OLD.workspace_id, NEW.workspace_id);
  end if;
  return null;
end $$;

create trigger workflow_order_prepare
  before insert or delete or update of workspace_id, archived_at on workflows
  for each row execute function prepare_workflow_order();
create trigger workflow_order_membership
  after insert or delete or update of workspace_id, archived_at on workflows
  for each row execute function revise_workflow_order();
` }
