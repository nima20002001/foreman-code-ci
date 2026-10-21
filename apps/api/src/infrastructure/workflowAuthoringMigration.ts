import { currentMultiNodeAgentMigration } from './currentMultiNodeAgentMigration.js'

const publication = currentMultiNodeAgentMigration.sql.match(
  /create or replace function eng04_check_current_publication\(\)[\s\S]*?end \$\$;/,
)?.[0]
if (!publication) throw new Error('Current workflow publication validation is unavailable.')

export const workflowAuthoringMigration = { version: 2026101346, sql: publication
  .replace("  if not found or to_jsonb(location_revision) is distinct from NEW.input->'expectedLocationRevision' then",
    '  if not found then')
  .replace("'expectedAgentConfigurationVersionIds','expectedLocationRevision','graph'",
    "'expectedAgentConfigurationVersionIds','graph'")
  .replace(' and a.current_configuration_version_id=c.id for share of c,a', ' for share of c,a')
}
