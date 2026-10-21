/** Board layout of each workflow's Kanban object. Separate from the workflow record, so moving it
 * never changes workflow revisions, versions or Runs. Null means hidden and not yet placed. */
export const workflowKanbanMigration = { version: 2026102140, sql: String.raw`
alter table workflows add column if not exists kanban_layout jsonb;
` }
