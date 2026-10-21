import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import type { JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import { createSourceManifest, sourceSha256 } from '../sources/manifest.js'
import { verificationDependencyBasis } from './dependencyBasis.js'
import type { JobSql } from './repository.js'

const workspaceId = 'workspace-ci', mainId = randomUUID(), principal = 'principal-owner'
function approved(commit: string, files: Record<string, string>) {
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, text]) => ({
    path, kind: 'file' as const, executable: false, byteSize: Buffer.byteLength(text), sha256: sourceSha256(Buffer.from(text)) }))
  const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip', git: { commit, tree: 'b'.repeat(40), objectFormat: 'sha1' }, entries, deletions: [] })
  return ApprovedSourceSchema.parse({ version: 1, workspaceId, ownerPrincipalId: principal, approvedByPrincipalId: principal,
    locationRevision: 1, mainId, originIdentityHash: `sha256:${'c'.repeat(64)}`, manifest, approvedAt: new Date().toISOString(), availability: 'retained' })
}
const dependencies = { 'package.json': '{"name":"app"}', 'pnpm-lock.yaml': 'lock: 1', 'pnpm-workspace.yaml': 'packages: [apps/*]',
  'apps/api/package.json': '{"name":"api"}' }
function fixture(changes: Record<string, string>) {
  const qualified = approved('1'.repeat(40), { ...dependencies, 'apps/api/src/index.ts': 'export const a = 1' })
  const requested = approved('2'.repeat(40), { ...dependencies, 'apps/api/src/index.ts': 'export const a = 2', ...changes })
  const sql = { query: async (_text: string, values: unknown[]) => ({ rows: [qualified, requested]
    .filter(source => source.manifest.snapshotId === values[2]).map(record => ({ record })) }) } as unknown as JobSql
  const pin = (source: typeof qualified) => ({ approvedSourceId: source.manifest.approvedSourceId, snapshotId: source.manifest.snapshotId,
    manifestDigest: source.manifest.manifestDigest, commit: source.manifest.git!.commit })
  const profile = { sourceCommit: qualified.manifest.git!.commit, root: { source: pin(qualified) } } as unknown as JobVerificationProfile
  return { sql, profile, qualified: pin(qualified), requested: pin(requested) }
}

it('runs the qualification commit itself without a dependency basis', async () => {
  const f = fixture({})
  expect(await verificationDependencyBasis(f.sql, workspaceId, f.profile, f.qualified)).toBeUndefined()
})
it('admits another commit with byte-identical dependency files, recording what it was admitted on', async () => {
  const f = fixture({})
  const basis = await verificationDependencyBasis(f.sql, workspaceId, f.profile, f.requested)
  expect(basis?.qualificationCommit).toBe(f.qualified.commit)
  expect(basis?.inputs.map(input => input.path)).toEqual(['apps/api/package.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
})
it.each([['pnpm-lock.yaml', 'lock: 2'], ['apps/api/package.json', '{"name":"api","dependencies":{"x":"1"}}'],
  ['packages/new/package.json', '{"name":"new"}']])('makes a commit that changes %s wait for a new qualification', async (path, text) => {
  const f = fixture({ [path]: text })
  await expect(verificationDependencyBasis(f.sql, workspaceId, f.profile, f.requested)).rejects.toMatchObject({ code: 'JOB_DEPENDENCIES_CHANGED' })
})
