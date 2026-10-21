export const runPresentationMigration = { version: 270206, sql: String.raw`
-- Historical versions remain immutable readback data; current writers and
-- execution admission still require semantics 3 and publication receipts.
alter table workflow_versions drop constraint workflow_versions_execution_semantics_version_check;
alter table workflow_versions add constraint workflow_versions_execution_semantics_version_check
  check (execution_semantics_version in (1,2,3));

create function protect_historical_workflow_version() returns trigger
language plpgsql security invoker as $$
begin
  raise exception 'Historical workflow versions are immutable' using errcode='23514';
end $$;
create trigger historical_workflow_version_immutable before update or delete on workflow_versions
  for each row when (old.execution_semantics_version<>3) execute function protect_historical_workflow_version();

create or replace function eng04_repeat_executable_graph(graph jsonb) returns jsonb
language sql immutable strict security invoker as $$
  select (graph - array['name','description','version','createdAt','updatedAt','nodes'])
    || jsonb_build_object('nodes', (select coalesce(jsonb_agg(
      node - array['name','label','position','width','height'] order by ordinal),'[]'::jsonb)
      from jsonb_array_elements(graph->'nodes') with ordinality as n(node,ordinal)))
$$;
` }
