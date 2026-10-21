import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  ApprovedSourceSchema, SourceGetInputSchema, SourceRootBindInputSchema, SourceRootGetInputSchema,
  SourceRootRecordSchema, type SourceRootRecord,
} from '@foreman-code/contracts/source-admission'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { prepareRunSources } from '../src/modules/sources/runSource.js'
import { DomainError } from '../src/modules/errors.js'
import type { PostgresSourceService } from '../src/modules/sources/service.js'

function fixture(policies: SourceManifest['executablePolicy'][] = ['strip']) {
  const workspaceId = 'workspace-source'
  const mainId = randomUUID()
  const principal: ManagementPrincipal = {
    id: 'source-owner', name: 'Owner', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    grants: [{ actions: ['source_roots:bind'], scope: { workspaceIds: [workspaceId] } }],
  }
  const approved = (executablePolicy: SourceManifest['executablePolicy']) => ApprovedSourceSchema.parse({
    version: 1, workspaceId, ownerPrincipalId: principal.id, approvedByPrincipalId: principal.id,
    locationRevision: 1, mainId, originIdentityHash: `sha256:${'1'.repeat(64)}`,
    manifest: {
      version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
      capturePolicy: 'git-tree-v1', executablePolicy,
      git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1' },
      entries: [], deletions: [], totalEntries: 0, totalBytes: 0, manifestDigest: '1'.repeat(64),
    },
    approvedAt: '2026-10-01T00:00:00.000Z', availability: 'retained',
  })
  const selected = policies.map(approved)
  const fresh = approved('strip')
  const pin = (manifest: SourceManifest) => ({
    approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest,
  })
  const roots = selected.map(source => {
    const rootId = randomUUID()
    return SourceRootRecordSchema.parse({
      version: 1, source: pin(source.manifest),
      selection: {
        hostRef: { kind: 'main', mainId }, rootPolicyId: rootId,
        rootPolicyRevision: '1', locationRevision: '1',
      },
      binding: {
        version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId, rootId,
        bindingRevision: 1, locationRevision: 1, canonicalPath: `/runtime/${rootId}`,
        filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write',
        snapshotId: source.manifest.snapshotId, manifestDigest: source.manifest.manifestDigest,
      },
      ownerPrincipalId: principal.id, authorizedByPrincipalId: principal.id, registration: null,
      attestationId: randomUUID(), attestationDigest: '1'.repeat(64), boundAt: source.approvedAt,
    })
  })
  const heads = new Map(roots.map(root => [root.binding.rootId, root]))
  const rebind = (root: SourceRootRecord) => SourceRootRecordSchema.parse({
    ...root, source: pin(fresh.manifest),
    binding: { ...root.binding, bindingRevision: root.binding.bindingRevision + 1,
      snapshotId: fresh.manifest.snapshotId, manifestDigest: fresh.manifest.manifestDigest },
  })
  const sources = {
    get: vi.fn<PostgresSourceService['get']>(async (_principal, _transport, raw) => {
      const input = SourceGetInputSchema.parse(raw)
      return selected.find(source => source.manifest.snapshotId === input.snapshotId)!
    }),
    approveProject: vi.fn<PostgresSourceService['approveProject']>(async (_principal, input) => {
      fresh.manifest.executablePolicy = input.executablePolicy ?? 'preserve-approved'
      return fresh
    }),
    rootGet: vi.fn<PostgresSourceService['rootGet']>(async (_principal, _transport, raw) => {
      const input = SourceRootGetInputSchema.parse(raw)
      return heads.get(input.rootId)!
    }),
    bindRoot: vi.fn<PostgresSourceService['bindRoot']>(async (_principal, _transport, raw) => {
      const input = SourceRootBindInputSchema.parse(raw)
      const root = [...heads.values()].find(root => root.selection.rootPolicyId === input.selection.rootPolicyId)!
      if (root.binding.bindingRevision !== input.expectedBindingRevision) {
        throw new DomainError('SOURCE_ROOT_REVISION_CONFLICT', 'Binding changed.', 409)
      }
      const bound = rebind(root)
      heads.set(root.binding.rootId, bound)
      return { value: bound, replayed: false }
    }),
  }
  const pool = { query: vi.fn(async (text: string, values: unknown[]) => ({
    rows: text.includes('source_root_catalog')
      ? [{ current_binding_revision: String(heads.get(String(values[0]))!.binding.bindingRevision) }] : [],
  })) } as unknown as pg.Pool
  const start = (transport: 'http' | 'mcp' = 'http') => prepareRunSources(pool, sources, principal, {
    workspaceId, commandId: randomUUID(), source: transport, roots,
  })
  return { start, sources, roots, heads, rebind, fresh, principal }
}

describe('Run source preparation', () => {
  it.each([
    ['strip'], ['preserve-approved'], ['strip', 'preserve-approved'], ['preserve-approved', 'strip'],
  ] as SourceManifest['executablePolicy'][][])('preserves the strictest selected policy across %j', async (...policies) => {
    const f = fixture(policies)
    const result = await f.start('mcp')
    const executablePolicy = policies.includes('strip') ? 'strip' : 'preserve-approved'
    expect(f.sources.approveProject).toHaveBeenCalledWith(f.principal,
      expect.objectContaining({ executablePolicy }), { source: 'mcp' })
    expect(result.map(root => root.source.snapshotId)).toEqual(policies.map(() => f.fresh.manifest.snapshotId))
  })

  it('allows concurrent Starts to reuse the winning binding of the same snapshot', async () => {
    const f = fixture()
    const bind = f.sources.bindRoot.getMockImplementation()!
    let entered = 0
    let release!: () => void
    const bothEntered = new Promise<void>(resolve => { release = resolve })
    f.sources.bindRoot.mockImplementation(async (...args) => {
      if (++entered === 2) release()
      await bothEntered
      return bind(...args)
    })
    const [http, mcp] = await Promise.all([f.start('http'), f.start('mcp')])
    expect(http).toEqual(mcp)
    expect(http[0]?.binding.bindingRevision).toBe(2)
    expect(f.heads.get(f.roots[0]!.binding.rootId)).toEqual(http[0])
    expect(f.sources.bindRoot).toHaveBeenCalledTimes(2)
  })

  it.each(['source', 'selection', 'accessMode'] as const)('rejects a conflicting winning %s', async fact => {
    const f = fixture()
    const conflict = new DomainError('SOURCE_ROOT_REVISION_CONFLICT', 'Binding changed.', 409)
    f.sources.bindRoot.mockImplementation(async () => {
      const root = f.roots[0]!
      const winner = f.rebind(root)
      if (fact === 'source') {
        winner.source = root.source
        winner.binding.snapshotId = root.source.snapshotId
        winner.binding.manifestDigest = root.source.manifestDigest
      }
      if (fact === 'selection') winner.selection.rootPolicyRevision = '2'
      if (fact === 'accessMode') winner.binding.accessMode = 'read-only'
      f.heads.set(root.binding.rootId, SourceRootRecordSchema.parse(winner))
      throw conflict
    })
    await expect(f.start()).rejects.toBe(conflict)
    expect(f.sources.bindRoot).toHaveBeenCalledOnce()
  })

  it('preserves failures other than a binding revision conflict', async () => {
    const f = fixture()
    const denied = new DomainError('FORBIDDEN', 'Binding denied.', 403)
    f.sources.bindRoot.mockRejectedValue(denied)
    await expect(f.start()).rejects.toBe(denied)
    expect(f.sources.rootGet).toHaveBeenCalledOnce()
  })
})
