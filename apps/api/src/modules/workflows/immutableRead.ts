import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentConfigurationVersionSchema, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { SavedWorkflowVersionSchema, SavedWorkflowDefinitionSchema, canonicalGraphJson, type SavedWorkflowVersion } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'

/** Physical columns are authority too. A valid JSON body cannot impersonate a
 * different immutable row or be silently interpreted under another semantics. */
export interface ImmutableWorkflowVersionRow {
  id: string
  workspace_id: string
  workflow_id: string
  version: number
  entry_node_id: string
  execution_semantics_version: number
  record: unknown
}
export interface ImmutableAgentConfigurationRow {
  id: string
  workspace_id: string
  agent_id: string
  version: number
  record: unknown
}
export const IMMUTABLE_WORKFLOW_VERSION_COLUMNS = 'id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record'

interface CachedWorkflowVersion { version: SavedWorkflowVersion; digest: string; bytes: number }
const workflowVersions = new Map<string, CachedWorkflowVersion>()
const workflowVersionCacheBytes = 8 * 1024 * 1024
let retainedWorkflowVersionBytes = 0

function parseWorkflowVersionRecord(record: unknown): SavedWorkflowVersion {
  const parsed = SavedWorkflowVersionSchema.safeParse(record)
  if (!parsed.success) {
    throw new DomainError('WORKFLOW_VERSION_RECORD_INVALID', 'The immutable workflow version is invalid.', 409)
  }
  return parsed.data
}

function cacheWorkflowVersion(version: SavedWorkflowVersion, digest: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(version))
  if (bytes > workflowVersionCacheBytes) return
  const previous = workflowVersions.get(version.id)
  if (previous) {
    workflowVersions.delete(version.id)
    retainedWorkflowVersionBytes -= previous.bytes
  }
  while (workflowVersions.size >= 128 || retainedWorkflowVersionBytes + bytes > workflowVersionCacheBytes) {
    const oldest = workflowVersions.values().next().value!
    workflowVersions.delete(oldest.version.id)
    retainedWorkflowVersionBytes -= oldest.bytes
  }
  // Callers can mutate their returned records without changing the cached validation result.
  workflowVersions.set(version.id, { version: structuredClone(version), digest, bytes })
  retainedWorkflowVersionBytes += bytes
}

export function readImmutableWorkflowVersion(row: ImmutableWorkflowVersionRow,
  expected: { id?: string; workspaceId?: string; workflowId?: string } = {}): SavedWorkflowVersion {
  if (row.execution_semantics_version !== 3) throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED',
    'Only explicitly pinned current execution semantics 3 can be read.', 409)
  const previous = workflowVersions.get(row.id)
  // Every field is compared with the newly read record before reusing validation or its digest.
  const cached = previous && isDeepStrictEqual(row.record, previous.version) ? previous : undefined
  const version = cached?.version ?? parseWorkflowVersionRecord(row.record)
  if (version.id !== row.id || version.workspaceId !== row.workspace_id || version.workflowId !== row.workflow_id
    || version.version !== row.version || version.entryNodeId !== row.entry_node_id || version.executionSemanticsVersion !== row.execution_semantics_version
    || expected.id !== undefined && version.id !== expected.id
    || expected.workspaceId !== undefined && version.workspaceId !== expected.workspaceId
    || expected.workflowId !== undefined && version.workflowId !== expected.workflowId) {
    throw new DomainError('WORKFLOW_VERSION_PIN_MISMATCH', 'The immutable workflow version does not match its persisted identity.', 409)
  }
  // Hash the actual current definition, including optional-repeat presence.
  // Reading never fills an omitted field or retags a saved record.
  const digest = cached?.digest ?? `sha256:${createHash('sha256').update(canonicalGraphJson({
    definition: version.definition, configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId,
  })).digest('hex')}`
  if (digest !== version.contentHash) throw new DomainError('WORKFLOW_VERSION_HASH_MISMATCH', 'The immutable workflow version content hash does not match.', 409)
  if (!cached) cacheWorkflowVersion(version, digest)
  return cached ? structuredClone(version) : version
}

export function readImmutableAgentConfiguration(row: ImmutableAgentConfigurationRow,
  expected: { id?: string; workspaceId?: string; agentId?: string } = {}): AgentConfigurationVersion {
  const parsed = AgentConfigurationVersionSchema.safeParse(row.record)
  if (!parsed.success || parsed.data.id !== row.id || parsed.data.workspaceId !== row.workspace_id
    || parsed.data.agentId !== row.agent_id || parsed.data.version !== row.version
    || expected.id !== undefined && parsed.data.id !== expected.id
    || expected.workspaceId !== undefined && parsed.data.workspaceId !== expected.workspaceId
    || expected.agentId !== undefined && parsed.data.agentId !== expected.agentId) {
    throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'An immutable configuration does not match its persisted identity.', 409)
  }
  return parsed.data
}

/** Saved history keeps exact topology and configuration identities even when a harness is retired. */
export function readPinnedAgentConfigurations(version: SavedWorkflowVersion,
  rows: ImmutableAgentConfigurationRow[]): AgentConfigurationVersion[] {
  const pins = version.agentConfigurationVersionIds
  const agentIds = new Set(version.definition.nodes.flatMap((node) => node.kind === 'job' ? [] : [node.agentId]))
  const keys = Object.keys(pins)
  if (keys.length !== agentIds.size || keys.some((id) => !agentIds.has(id))
    || new Set(Object.values(pins)).size !== keys.length || rows.length !== keys.length) {
    throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'The immutable configurations do not match the pinned topology.', 409)
  }
  return rows.map((row) => {
    const id = pins[row.agent_id]
    if (id !== row.id) throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE',
      'An immutable configuration does not match its pinned Agent.', 409)
    return readImmutableAgentConfiguration(row, { id, workspaceId: version.workspaceId, agentId: row.agent_id })
  })
}

export function readSavedWorkflowDefinition(row: { id: string; workspace_id: string; record: unknown },
  expected: { workspaceId: string; workflowId?: string }) {
  const parsed = SavedWorkflowDefinitionSchema.safeParse(row.record)
  if (!parsed.success || parsed.data.id !== row.id || parsed.data.workspaceId !== row.workspace_id
    || row.workspace_id !== expected.workspaceId || expected.workflowId !== undefined && row.id !== expected.workflowId) {
    throw new DomainError('WORKFLOW_RECORD_INVALID', 'The workflow definition does not match its persisted scope.', 409)
  }
  return parsed.data
}
