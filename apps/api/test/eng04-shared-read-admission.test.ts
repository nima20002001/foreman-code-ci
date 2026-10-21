import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { sharedFixture } from './eng04-shared-fixture.js'
import { readImmutableWorkflowVersion, readImmutableAgentConfiguration } from '../src/modules/workflows/immutableRead.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { VersionHistoryService } from '../src/modules/workflows/historyManagement.js'
import { readLockedRepeatStartSnapshot } from '../src/modules/workflows/repeatStartRead.js'

const fences = vi.hoisted(() => ({ live: vi.fn(), native: vi.fn() }))
vi.mock('../src/modules/access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: fences.live }))
vi.mock('../src/modules/harnesses/nativeWorkflowConfiguration.js', () => ({ assertNativeWorkflowConfiguration: fences.native }))
beforeEach(() => vi.resetAllMocks())

function startSetup() {
  const t = sharedFixture()
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }], rowCount: 1 }
    if (sql.includes('from workspaces where')) return { rows: [t.locationRow], rowCount: 1 }
    if (sql.includes('from workflows where')) return { rows: [t.workflow], rowCount: 1 }
    if (sql.includes('from workflow_versions where')) return { rows: [t.versionRow], rowCount: 1 }
    if (sql.includes('from agents a')) return { rows: t.configurations, rowCount: t.configurations.length }
    if (sql.includes('from graph_drafts')) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected SQL ${sql}`)
  })
  const client = { query } as unknown as pg.PoolClient
  fences.live.mockResolvedValue(t.principal)
  const prepared = { location: structuredClone(t.location), row: structuredClone(t.locationRow) }
  return { ...t, query, client, prepared }
}

describe('ENG04 shared exact immutable SQL readers', () => {
  it('validates v3 physical pins/hash and rejects retired physical execution tags', () => {
    const t = sharedFixture()
    expect(readImmutableWorkflowVersion(t.versionRow)).toEqual(t.version)
    expect(() => readImmutableWorkflowVersion({ ...t.versionRow, execution_semantics_version: 2 })).toThrow()
    expect(readImmutableAgentConfiguration(t.configurations[0]!)).toEqual(t.f.configurations[0])
  })
  it('rejects physical scope/tag/version/entry/hash mismatches rather than accepting plausible JSON', () => {
    const t = sharedFixture()
    for (const row of [
      { ...t.versionRow, id: 'other' }, { ...t.versionRow, workspace_id: 'other' }, { ...t.versionRow, workflow_id: 'other' },
      { ...t.versionRow, version: 2 }, { ...t.versionRow, execution_semantics_version: 2 }, { ...t.versionRow, entry_node_id: 'other' },
      { ...t.versionRow, record: { ...t.version, contentHash: `sha256:${'f'.repeat(64)}` } },
      { ...t.versionRow, record: { ...t.version, executionSemanticsVersion: 99 } },
    ]) expect(() => readImmutableWorkflowVersion(row)).toThrow()
    expect(() => readImmutableWorkflowVersion(t.versionRow, { id: 'another-pin' })).toThrow()
    for (const row of [{ ...t.configurations[0]!, id: 'other' }, { ...t.configurations[0]!, workspace_id: 'other' },
      { ...t.configurations[0]!, agent_id: 'other' }, { ...t.configurations[0]!, version: 2 }]) {
      expect(() => readImmutableAgentConfiguration(row)).toThrow()
    }
  })
  it('uses the same exact V3 reads for engine and saved views and keeps direct inserts closed', async () => {
    const t = sharedFixture(), query = vi.fn().mockResolvedValue({ rows: [t.versionRow], rowCount: 1 })
    const repository = new PostgresWorkflowRepository({ query } as unknown as pg.Pool)
    expect(await repository.getSavedVersion(t.version.id)).toEqual(t.version)
    expect(await repository.getCurrentSavedVersion(t.run.workspaceId, t.run.workflowId)).toEqual(t.version)
    expect(query.mock.calls[1]![0]).toContain('version.workspace_id=workflow.workspace_id and version.workflow_id=workflow.id')
    expect(await repository.getVersion(t.version.id)).toEqual(t.version)
    expect(await repository.getCurrentVersion(t.run.workspaceId, t.run.workflowId)).toEqual(t.version)
    query.mockClear()
    expect(repository).not.toHaveProperty('insertVersion')
    expect(repository).not.toHaveProperty('save')
    expect(query).not.toHaveBeenCalled()
  })
  it('keeps history grants explicit and validates the same exact pin in list and get', async () => {
    const t = sharedFixture(), query = vi.fn().mockResolvedValue({ rows: [t.versionRow], rowCount: 1 })
    const service = new VersionHistoryService({ query } as unknown as pg.Pool)
    expect((await service.workflow(t.principal, { workspaceId: t.run.workspaceId, workflowId: t.run.workflowId, versionId: t.version.id })).version).toEqual(t.version)
    expect((await service.workflows(t.principal, { workspaceId: t.run.workspaceId, workflowId: t.run.workflowId, limit: 10 })).items).toEqual([t.version])
    query.mockClear()
    await expect(service.workflow({ ...t.principal, grants: [] }, { workspaceId: t.run.workspaceId,
      workflowId: t.run.workflowId, versionId: t.version.id })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(query).not.toHaveBeenCalled()
  })
})

describe('ENG04 shared locked Start read, with synthetic SQL/native-policy seams', () => {
  it('accepts complete registered folder metadata and fences changes to that metadata', async () => {
    const t = startSetup()
    const mainId = randomUUID()
    const identity = { device: '1', inode: '2', mountId: '3', hostRef: { kind: 'main' as const, mainId },
      applicationInstallationId: mainId, directoryIdentityHash: 'a'.repeat(64) }
    t.locationRow.execution_location_identity = identity
    t.prepared.row.execution_location_identity = structuredClone(identity)
    const result = await readLockedRepeatStartSnapshot(t.client, t.principal, t.request, t.prepared)
    expect(result.workspace.location).toEqual(t.location)
    identity.mountId = '4'
    await expect(readLockedRepeatStartSnapshot(t.client, t.principal, t.request, t.prepared))
      .rejects.toMatchObject({ code: 'LOCATION_REVISION_CONFLICT' })
  })
  it('retains all exact v3 pins, rechecks live grants and writes no Run/receipt/native action', async () => {
    const t = startSetup()
    const result = await readLockedRepeatStartSnapshot(t.client, t.principal, t.request, t.prepared)
    expect(result.executable.version).toEqual(t.version)
    expect(result.workspace.location).toEqual(t.location)
    expect(fences.live).toHaveBeenCalledWith(t.client, t.principal.id)
    expect(fences.native).toHaveBeenCalledTimes(2)
    for (const [sql] of t.query.mock.calls) expect(sql).not.toMatch(/\b(insert|delete|update\s+\w+\s+set)\b/i)
    expect(t.query.mock.calls.some(([sql]) => sql.includes('for share of a,v'))).toBe(true)
  })
  it('fails on revoked or missing live grants before reading private version/configuration data', async () => {
    const t = startSetup()
    fences.live.mockResolvedValue({ ...t.principal, grants: [] })
    await expect(readLockedRepeatStartSnapshot(t.client, t.principal, t.request, t.prepared)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(t.query).not.toHaveBeenCalled()
    expect(fences.native).not.toHaveBeenCalled()
  })
  it.each(['revision', 'version', 'location', 'identity', 'config', 'scope'] as const)('blocks stale %s identity', async (change) => {
    const t = startSetup()
    if (change === 'revision') t.workflow.revision = '8'
    if (change === 'version') t.workflow.current_version_id = 'other'
    if (change === 'location') t.locationRow.execution_location.rootPath = '/other'
    if (change === 'identity') t.locationRow.execution_location_identity.inode = '3'
    if (change === 'config') t.configurations[0]!.current_configuration_version_id = 'other'
    if (change === 'scope') t.versionRow.workspace_id = 'other'
    await expect(readLockedRepeatStartSnapshot(t.client, t.principal, t.request, t.prepared)).rejects.toThrow()
    expect(fences.native).not.toHaveBeenCalled()
  })
  it('rejects a spoofed prepared location hash even when the database before/after image matches', async () => {
    const t = startSetup()
    t.prepared.location.identityHash = `sha256:${'0'.repeat(64)}`
    await expect(readLockedRepeatStartSnapshot(t.client, t.principal, t.request, t.prepared)).rejects.toMatchObject({ code: 'LOCATION_REVISION_CONFLICT' })
  })
  it('does not admit a disappeared displayed draft or unsupported native configuration', async () => {
    const t = startSetup()
    await expect(readLockedRepeatStartSnapshot(t.client, t.principal, { ...t.request, draftId: 'gone', expectedDraftRevision: 1 }, t.prepared))
      .rejects.toMatchObject({ code: 'DISPLAYED_GRAPH_NOT_PUBLISHED' })
    fences.native.mockImplementation(() => { throw new Error('synthetic-native-policy-denied') })
    await expect(readLockedRepeatStartSnapshot(t.client, t.principal, t.request, t.prepared)).rejects.toThrow('synthetic-native-policy-denied')
  })
})
