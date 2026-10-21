import { QUALIFICATION_TARGET_PROFILE } from './profiles.js'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'
import { HarnessQualificationRegistry } from './registry.js'
import { requireHarnessQualification, runAsQualificationCandidate, runWithReadOnlyQualification } from './gate.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'readonly-worker-qualification-')); roots.push(root)
  const bytes = Buffer.from('source-only binary identity fixture; never executed')
  const binary = join(root, 'codex'); await writeFile(binary, bytes, { mode: 0o700 })
  const sha256 = createHash('sha256').update(bytes).digest('hex'), revision = 'source-test-current-suite'
  const record = HarnessQualificationSchema.parse({ harness: 'codex', version: '0.132.0', binarySha256: sha256,
    status: 'qualified', profile: QUALIFICATION_TARGET_PROFILE.codex, suiteRevision: revision, checks: [{ id: 'protocol', passed: true, detail: null }],
    failureReason: null, startedAt: '2026-10-01T00:00:00.000Z', checkedAt: '2026-10-01T00:01:00.000Z' })
  return { binary, sha256, revision, record }
}
describe('operation-scoped readonly Main qualification with authority doubles, no native proof', () => {
  it('denies known baseline without authenticated proof and ignores candidate bypass inside the worker scope', async () => {
    const f = await fixture(), find = vi.fn(async () => null)
    const registry = new HarnessQualificationRegistry({ list: async () => [], find }, { codex: f.revision })
    await expect(runWithReadOnlyQualification(registry, () => requireHarnessQualification('codex', 'codex-cli 0.154.0', f.binary))).rejects.toMatchObject({ result: { error: { code: 'HARNESS_UNQUALIFIED' } } })
    await expect(runWithReadOnlyQualification(registry, () => runAsQualificationCandidate('codex', f.sha256, f.binary,
      () => requireHarnessQualification('codex', 'codex-cli 0.132.0', f.binary)))).rejects.toMatchObject({ result: { error: { code: 'HARNESS_UNQUALIFIED' } } })
    await expect(requireHarnessQualification('codex', 'codex-cli 0.154.0', f.binary)).resolves.toBeUndefined()
    expect(find).toHaveBeenCalledTimes(2)
  })
  it('isolates parallel operations and freshly rejects replacement connection generations', async () => {
    const f = await fixture()
    let generation = 1
    const accepted = new HarnessQualificationRegistry({ list: async () => [], find: async () => generation === 1 ? f.record : null }, { codex: f.revision })
    const otherOperation = new HarnessQualificationRegistry({ list: async () => [], find: async () => null }, { codex: f.revision })
    const results = await Promise.allSettled([
      runWithReadOnlyQualification(accepted, () => requireHarnessQualification('codex', 'codex-cli 0.132.0', f.binary)),
      runWithReadOnlyQualification(otherOperation, () => requireHarnessQualification('codex', 'codex-cli 0.132.0', f.binary)),
    ])
    expect(results.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
    generation = 2
    await expect(runWithReadOnlyQualification(accepted, () => requireHarnessQualification('codex', 'codex-cli 0.132.0', f.binary))).rejects.toMatchObject({ result: { error: { code: 'HARNESS_UNQUALIFIED' } } })
  })
  it('rejects stale SHA/suite and nonpositive checks rather than trusting a qualified label', async () => {
    const f = await fixture()
    for (const record of [{ ...f.record, binarySha256: 'b'.repeat(64) }, { ...f.record, suiteRevision: 'stale' },
      { ...f.record, checks: [] }, { ...f.record, checks: [{ id: 'protocol', passed: false, detail: null }] }]) {
      const registry = new HarnessQualificationRegistry({ list: async () => [], find: async () => record }, { codex: f.revision })
      await expect(runWithReadOnlyQualification(registry, () => requireHarnessQualification('codex', 'codex-cli 0.132.0', f.binary))).rejects.toMatchObject({ result: { error: { code: 'HARNESS_UNQUALIFIED' } } })
    }
  })
})
