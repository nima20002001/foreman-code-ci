import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { nativeRegistryProjection } from '../src/modules/harnesses/recovery/registryObservation.js'
import { bootIdentity, processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { storageBatch } from '../src/modules/harnesses/recovery/storage.js'

const execute = promisify(execFile)
const ownerKey = (owner: string) => createHash('sha256').update(owner).digest('hex')

function seed(root: string, owner: string, closed = false) {
  const ownerDirectory = join(root, ownerKey(owner)), id = randomUUID(), path = join(ownerDirectory, id)
  mkdirSync(path, { mode: 0o700, recursive: true })
  const intent = { format: 1, id, owner, boot: bootIdentity(), parent: processIdentity(process.pid), controlKey: 'a'.repeat(64) }
  writeFileSync(join(path, 'intent.json'), JSON.stringify(intent), { mode: 0o600 })
  if (closed) writeFileSync(join(path, 'closed.json'), JSON.stringify({ format: 2, id, owner, boot: intent.boot,
    evidence: 'native_not_started' }), { mode: 0o600 })
  return { ownerDirectory, id, path, intent }
}

describe.skipIf(process.platform !== 'linux')('passive harness metadata with compact retired history', () => {
  it('preserves over 10,000 exact retired owner receipts and one unresolved launch, including after process restart', async () => {
    const started = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'harness-retired-history-')), registry = new NativeProcessRegistry(root)
    const receipts: { path: string; value: string }[] = [], retirements: Promise<boolean>[] = []
    try {
      // Positive format-2 closure fixtures use the real retirement/receipt/GC path.
      // No native provider or guardian is launched by this storage regression.
      await nativeRegistryProjection(root).retirementBatch(async () => {
        await storageBatch(Array.from({ length: 10_001 }, (_, index) => index), async index => {
          const owner = `retired-owner-${index}`, row = seed(root, owner, true)
          const retirement = registry.closeOwner(owner)
          retirements.push(retirement)
          await retirement
          const path = join(row.ownerDirectory, 'retired.json')
          receipts.push({ path, value: JSON.stringify({ format: 2, owner, id: row.id, observation: { owner, launchId: row.id,
            bootId: row.intent.boot, lifecycle: 'closed', closureEvidence: 'native_not_started' } }) })
          expect(readdirSync(row.ownerDirectory)).toEqual([`closed-${row.id}.json`, 'retired.json'])
        })
      })
      expect((await Promise.all(retirements)).every(Boolean)).toBe(true)
      const unresolved = seed(root, 'unresolved-owner')
      const snapshot = registry.snapshot()
      expect(snapshot.launches.length).toBeLessThanOrEqual(10_000)
      expect(snapshot.launches.find(row => row.launchId === unresolved.id)).toMatchObject({ owner: 'unresolved-owner', lifecycle: 'closure-unconfirmed' })
      expect(snapshot.launches.filter(row => row.lifecycle !== 'closed')).toHaveLength(1)
      const script = `import { NativeProcessRegistry } from './src/modules/harnesses/recovery/processRegistry.ts';
        process.stdout.write(JSON.stringify(new NativeProcessRegistry(process.argv[1]).snapshot().launches));`
      // The full 10,000-row snapshot exceeds execFile's default output buffer.
      const restarted = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root], {
        cwd: new URL('../', import.meta.url), timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
      })
      const restored = JSON.parse(restarted.stdout) as { lifecycle: string; closureEvidence?: string }[]
      expect(restored).toHaveLength(10_000)
      expect(restored.filter(row => row.lifecycle === 'closed').every(row => row.closureEvidence === 'native_not_started')).toBe(true)
      expect(restored.filter(row => row.lifecycle !== 'closed')).toEqual([{ owner: 'unresolved-owner', launchId: unresolved.id,
        bootId: unresolved.intent.boot, lifecycle: 'closure-unconfirmed' }])
      for (const receipt of receipts) expect(readFileSync(receipt.path, 'utf8')).toBe(receipt.value)
      expect(readdirSync(unresolved.path)).toEqual(['intent.json'])
      await expect(registry.closeRegistration(registry.scope('retired-owner-0'), randomUUID())).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(registry.reserveLaunch('unresolved-owner')).rejects.toThrow('active or unconfirmed')
    } finally { rmSync(root, { recursive: true, force: true }) }
    // CI treats 180 seconds without a completed test as a hang.
    expect(performance.now() - started).toBeLessThan(180_000)
  // Every retirement fsyncs its receipts; slower disks need time for the full history.
  }, 1_200_000)

  it('keeps the 10,000-launch scan bound while excluding compact receipts inside a live owner directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-live-bound-')), registry = new NativeProcessRegistry(root)
    try {
      const owner = 'live-owner'
      let extra: ReturnType<typeof seed> | undefined
      for (let index = 0; index < 10_001; index++) extra = seed(root, owner)
      expect(() => registry.snapshot()).toThrow('limit-exceeded')
      rmSync(extra!.path, { recursive: true })
      writeFileSync(join(extra!.ownerDirectory, 'retired.json'), JSON.stringify({ format: 2, owner, id: extra!.id }), { mode: 0o600 })
      const snapshot = registry.snapshot()
      expect(snapshot.launches).toHaveLength(10_000)
      expect(snapshot.launches.every(row => row.lifecycle === 'closure-unconfirmed')).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)
})
