import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { RunPlacementReadService } from '../src/modules/placement/readService.js'

function fixture() {
  const saved = makeCurrentWorkflowFixture('placement-readback', 'sequential')
  const principal: ManagementPrincipal = {
    id: 'placement-reader', name: 'Placement reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['runs:read', 'workspace_locations:read'], scope: {} }],
  }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('management_principals')) return { rows: [{
      id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
      expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
    }], rowCount: 1 }
    if (sql.includes('run_node_placements')) return { rows: [], rowCount: 0 }
    if (sql.includes('workflow_versions')) return { rows: [{ run: saved.run, version: saved.version }], rowCount: 1 }
    if (sql.includes('from runs')) return { rows: [{ id: saved.run.id }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  const observations = vi.fn(async () => [])
  const service = new RunPlacementReadService(pool, observations)
  const input = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
    runId: saved.run.id, nodeId: saved.version.definition.nodes[0]!.id }
  return { saved, principal, observations, service, input }
}

describe('Run node computer readback', () => {
  it('returns missing placement evidence for an inherited Main node in an existing Run', async () => {
    const f = fixture()
    expect(await f.service.get(f.principal, f.input)).toEqual({
      ...f.input, readback: { evidence: 'legacy_missing', originalMainInstallationId: null },
    })
    expect(f.observations).not.toHaveBeenCalled()
  })

  it('does not report a nonexistent node as inherited Main', async () => {
    const f = fixture()
    await expect(f.service.get(f.principal, { ...f.input, nodeId: 'missing-node' }))
      .rejects.toMatchObject({ code: 'RUN_NODE_NOT_FOUND', status: 404 })
  })

  it('retains the error when a saved placement requires a missing binding', async () => {
    const f = fixture()
    const node = f.saved.version.definition.nodes[0]!
    node.placement = SavedNodePlacementSchema.parse({
      schemaVersion: 1, hostRef: { kind: 'main', mainId: '10000000-0000-4000-8000-000000000001' },
      rootPolicyId: 'root-policy', rootPolicyRevision: '1', locationRevision: '1',
      projectRoot: '/project', cwdPolicy: 'project-root', relativeCwd: '',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'installation',
    })
    await expect(f.service.get(f.principal, f.input))
      .rejects.toMatchObject({ code: 'RUN_NODE_PLACEMENT_NOT_FOUND', status: 404 })
  })
})
