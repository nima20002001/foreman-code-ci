import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { NodePlacementChoicesService } from '../src/modules/placement/choicesService.js'
import { CurrentWorkflowAuthoring } from '../src/modules/workflows/currentAuthoring.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'

function fixture() {
  const f = makeCurrentWorkflowFixture('agent-consumers', 'sequential'), configuration = f.configurations[0]!
  const graph = WorkflowDefinitionV3Schema.parse({ ...f.version.definition, nodes: [f.version.definition.nodes[0],
    { kind: 'job', id: f.version.definition.nodes[1]!.id, name: 'Build job', jobDefinitionId: 'job-definition',
      jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version' }] })
  const pins = { [configuration.agentId]: configuration.id }
  const version = WorkflowVersionV3Schema.parse({ ...f.version, definition: graph, agentConfigurationVersionIds: pins })
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['workflows:read', 'graph:read', 'agents:read', 'workspace_locations:read', 'source_roots:read', 'sources:read', 'harnesses:read'], scope: {} }] }
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    let rows: unknown[]
    if (['begin', 'commit', 'rollback'].includes(sql) || sql.startsWith('select pg_advisory_xact_lock')) rows = []
    else if (sql.includes('from management_principals')) rows = [{ id: principal.id, name: principal.name, audience: principal.audience,
      grants: principal.grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }]
    else if (sql.startsWith('select id from application_installation')) rows = [{ id: 'main-fixture' }]
    else if (sql.startsWith('select v.record from workflows')) rows = [{ record: version }]
    else if (sql.startsWith('select archived_at from workspaces')) rows = [{ archived_at: null }]
    else if (sql.startsWith('select record,revision::text,current_version_id,archived_at from workflows')) rows = [{ record: graph, revision: '1', current_version_id: null, archived_at: null }]
    else if (sql.startsWith('select location_revision::text')) rows = [{ revision: '1' }]
    else if (sql.startsWith('select id,current_configuration_version_id from agents')) {
      expect(values).toEqual([graph.workspaceId, [configuration.agentId]])
      rows = [{ id: configuration.agentId, current_configuration_version_id: configuration.id }]
    } else if (sql.includes('from agent_configuration_versions')) {
      expect(values).toEqual([[configuration.id]])
      rows = [{ id: configuration.id, workspace_id: configuration.workspaceId, agent_id: configuration.agentId,
        version: configuration.version, record: configuration }]
    } else if (sql.startsWith('select coalesce(max(version),0)+1')) rows = [{ next: '2' }]
    else throw new Error(`Unscripted current-consumer SQL: ${sql}`)
    return { rows, rowCount: rows.length }
  })
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  return { graph, configuration, pins, principal, query, pool }
}

describe('current Agent-only consumer boundaries', () => {
  it('denies Job nodes before Agent destination discovery, while retaining the saved Agent pin', async () => {
    const f = fixture(), list = vi.fn(async () => ({ choices: [], pending: false }))
    const service = new NodePlacementChoicesService(f.pool, { list })
    const input = { workspaceId: f.graph.workspaceId, workflowId: f.graph.id, agentConfigurationVersionId: f.configuration.id }
    await expect(service.get(f.principal, { ...input, nodeId: f.graph.nodes[1]!.id }))
      .rejects.toMatchObject({ code: 'PLACEMENT_CONFIGURATION_CONFLICT' })
    expect(list).not.toHaveBeenCalled()
    await expect(service.get(f.principal, { ...input, nodeId: f.graph.nodes[0]!.id })).resolves.toMatchObject({ choices: [] })
    expect(list).toHaveBeenCalledOnce()
  })

  it('validates mixed current authoring with only actual Agent configuration pins', async () => {
    const f = fixture(), service = new CurrentWorkflowAuthoring(f.pool, new PostgresCommandCoordinator(f.pool))
    await expect(service.validate(f.principal, { workspaceId: f.graph.workspaceId, workflowId: f.graph.id,
      expectedRevision: 1, expectedWorkflowVersionId: null, executionSemanticsVersion: 3,
      expectedAgentConfigurationVersionIds: f.pins, graph: f.graph }))
      .resolves.toMatchObject({ valid: true, expectedAgentConfigurationVersionIds: f.pins })
    expect(f.query.mock.calls.at(-1)).toEqual(['commit'])
  })

  it('keeps the deterministic permission fixture limited to its real provider profiles', () => {
    expect(new DeterministicNativeSessionManager('codex').harness).toBe('codex')
    expect(() => new DeterministicNativeSessionManager('claude', '2.1.284')).toThrow('FIXTURE_PROVIDER_UNSUPPORTED')
  })
})
