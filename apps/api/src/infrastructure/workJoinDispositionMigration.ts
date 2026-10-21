export const workJoinDispositionMigration = { version: 269308, sql: String.raw`
create or replace function work_join_required_edges(work_run_id text, round_id text, join_node_id text) returns text[]
language sql stable as $$
  with recursive
  pinned as (select repeat_pinned_version(work_run_id) as value),
  nodes as (select n.value from pinned p
    cross join lateral jsonb_array_elements(p.value #> '{definition,nodes}') n(value)),
  edges as (select e.value from pinned p
    cross join lateral jsonb_array_elements(p.value #> '{definition,edges}') e(value)
    where e.value->>'kind'='execution'),
  decisions as (
    select a.activation_id,x.execution_id,a.workflow_node_id, x.result_json::jsonb->'output' as payload
    from run_work_results x join run_work_activations a on a.run_id=x.run_id and a.activation_id=x.activation_id
    where x.run_id=work_run_id and work_round_id(x.run_id,a.activation_id)=round_id
  ),
  routes as (
    select e.value->>'id' as relationship_id,n.value->>'id' as source,
      case when e.value->>'source'=n.value->>'id' then e.value->>'target' else e.value->>'source' end as target
    from pinned cross join nodes n left join decisions d on d.workflow_node_id=n.value->>'id'
    join edges e on (e.value->>'source'=n.value->>'id'
      or e.value->>'workRequestDirection'='both' and e.value->>'target'=n.value->>'id')
      and e.value->>'id'=any(work_saved_routes(pinned.value,n.value,d.payload))
      and not exists(select 1 from run_work_denials denied
        where denied.run_id=work_run_id and denied.requester_activation_id=d.activation_id
          and denied.relationship_id=e.value->>'id')
      and not exists(select 1 from run_work_unresolved unresolved
        where unresolved.run_id=work_run_id and unresolved.execution_id=d.execution_id
          and unresolved.reason='repeated_exhausted_route' and unresolved.relationship_id=e.value->>'id')
  ),
  reachable(node_id) as (
    select coalesce((select workflow_node_id from run_work_activations
      where run_id=work_run_id and activation_id=round_id),(select value->>'entryNodeId' from pinned))
    union
    select routes.target from reachable join routes on routes.source=reachable.node_id
      where reachable.node_id<>join_node_id
  )
  select coalesce(array_agg(distinct r.relationship_id order by r.relationship_id),'{}')
    from routes r join reachable on reachable.node_id=r.source join edges e on e.value->>'id'=r.relationship_id
    where r.target=join_node_id and e.value->>'target'=join_node_id;
$$;

` } as const
