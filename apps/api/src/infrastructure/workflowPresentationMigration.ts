import { currentMultiNodeAgentMigration } from './currentMultiNodeAgentMigration.js'

const publication = currentMultiNodeAgentMigration.sql.match(
  /create or replace function eng04_check_current_publication\(\)[\s\S]*?end \$\$;/,
)?.[0]
if (!publication) throw new Error('Current workflow publication validation is unavailable.')

export const workflowPresentationMigration = { version: 270207, sql: String.raw`
create function workflow_node_presentation(graph jsonb) returns jsonb
language sql immutable strict security invoker as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',node->'id','name',node->'name','label',node->'label')) order by ordinal),'[]'::jsonb)
  from jsonb_array_elements(graph->'nodes') with ordinality as n(node,ordinal)
$$;
` + publication
  .replace("'graph','commandId','stagedAgents'", "'graph','commandId','expectedNodePresentation','stagedAgents'")
  .replace("    and NEW.input #> '{graph,version}'", String.raw`
    and (not (NEW.input ? 'expectedNodePresentation')
      or NEW.input->'expectedNodePresentation'=workflow_node_presentation(workflow.record))
    and NEW.input #> '{graph,version}'`)
}
