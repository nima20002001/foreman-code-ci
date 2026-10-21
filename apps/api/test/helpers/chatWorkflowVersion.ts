import { createHash } from 'node:crypto'
import { canonicalGraphJson, makeCurrentWorkflowFixture, type SavedWorkflowVersion } from '@foreman-code/contracts/wave25'

export interface ChatVersionIds { workspaceId: string; workflowId: string; workflowNodeId: string; agentId: string; configurationId: string }

const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim()

/** True for the shared current saved Version read the conversation feature context issues through its SQL port. */
export function isCurrentVersionRead(sql: string): boolean {
  const text = normalized(sql)
  return text.startsWith('select version.id,version.workspace_id,version.workflow_id,version.version,version.entry_node_id,')
    && text.includes('from workflows workflow join workflow_versions version on version.id = workflow.current_version_id')
}

/** True for the exact saved Version read by id. */
export function isSavedVersionRead(sql: string): boolean {
  return normalized(sql).startsWith('select id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record from workflow_versions where id = $1')
}

/** True for the Run-origin lookup of the Version that Run executed. */
export function isRunVersionRead(sql: string): boolean {
  return normalized(sql) === 'select workflow_version_id from runs where id=$1 and workspace_id=$2 and workflow_id=$3'
}

/** One saved Version as PostgreSQL hands it to the immutable reader, with its content hash made valid. */
export function immutableVersionRow(version: SavedWorkflowVersion) {
  const record = structuredClone(version)
  record.contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({ definition: record.definition,
    configurations: record.agentConfigurationVersionIds, entryNodeId: record.entryNodeId })).digest('hex')}`
  return { id: record.id, workspace_id: record.workspaceId, workflow_id: record.workflowId, version: record.version,
    entry_node_id: record.entryNodeId, execution_semantics_version: record.executionSemanticsVersion, record }
}

/** The saved current Version row for one Agent node, built from the shared current workflow fixture. */
export function chatWorkflowVersionRow(ids: ChatVersionIds) {
  const { version } = makeCurrentWorkflowFixture('chat-version', 'single')
  return immutableVersionRow(JSON.parse(JSON.stringify(version).replaceAll('cfg-chat-version-0', ids.configurationId)
    .replaceAll('agent-chat-version-0', ids.agentId).replaceAll('node-chat-version-0', ids.workflowNodeId)
    .replaceAll('wf-chat-version', ids.workflowId).replaceAll('ws-chat-version', ids.workspaceId)) as SavedWorkflowVersion)
}
