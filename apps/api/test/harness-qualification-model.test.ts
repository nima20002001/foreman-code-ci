import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import type { QualificationSuiteInput } from '../src/modules/harnesses/qualification/types.js'

it.skipIf(process.platform === 'win32')('passes each saved harness model to the live qualification suite, or null when unsaved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-model-'))
  try {
    for (const [harness, revision, expected] of [
      ['codex', 0, null], ['codex', 1, 'saved-codex-model'],
    ] as const) {
      const binary = join(directory, `fake-${harness}`)
      const binaryBytes = `#!/bin/sh\necho "${harness === 'codex' ? 'codex-cli ' : ''}0.158.0"\n`
      await writeFile(binary, binaryBytes)
      await chmod(binary, 0o700)
      const run = vi.fn(async (input: QualificationSuiteInput) => ({ checks: [{ id: 'live', passed: true, detail: null }], evidence: { model: input.model } }))
      const save = vi.fn(async () => undefined)
      const service = new HarnessQualificationService(
        { find: async () => undefined, save } as unknown as ConstructorParameters<typeof HarnessQualificationService>[0],
        { inspectBinary: async () => ({ binary, sha256: createHash('sha256').update(binaryBytes).digest('hex') }), trusted: async () => true } as unknown as ConstructorParameters<typeof HarnessQualificationService>[1],
        { codex: { harness: 'codex', revision: 'test', run } },
        { codex: binary },
        {} as ConstructorParameters<typeof HarnessQualificationService>[4],
        { getManagedHarnessDefaults: async () => ({ revision,
          defaults: { codex: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'saved-codex-model' } },
        }) },
        async () => 'static',
      )
      await service.begin(harness)
      await vi.waitFor(() => assert.equal(save.mock.calls.length, 2))
      assert.equal(run.mock.calls.length, 1)
      assert.equal(run.mock.calls[0]?.[0].model, expected)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('retries only a timed-out static probe with a fresh, longer deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-timeout-'))
  try {
    const binary = join(directory, 'fake-codex')
    const binaryBytes = '#!/bin/sh\necho "codex-cli 0.158.0"\n'
    await writeFile(binary, binaryBytes)
    await chmod(binary, 0o700)
    const save = vi.fn(async (qualification: HarnessQualification) => { void qualification })
    const run = vi.fn(async () => ({ checks: [{ id: 'live', passed: true, detail: null }], evidence: {} }))
    const staticCheck = vi.fn(async (_harness: unknown, _binary: unknown, _version: unknown, signal: AbortSignal) => {
      if (staticCheck.mock.calls.length === 1) throw new DOMException('Timed out', 'TimeoutError')
      assert.equal(signal.aborted, false)
      return 'schema-hash'
    })
    const onFinished = vi.fn()
    const service = new HarnessQualificationService(
      { find: async () => undefined, save } as unknown as ConstructorParameters<typeof HarnessQualificationService>[0],
      { inspectBinary: async () => ({ binary, sha256: createHash('sha256').update(binaryBytes).digest('hex') }), trusted: async () => true } as unknown as ConstructorParameters<typeof HarnessQualificationService>[1],
      { codex: { harness: 'codex', revision: 'test', run } },
      { codex: binary }, {} as ConstructorParameters<typeof HarnessQualificationService>[4],
      { getManagedHarnessDefaults: async () => ({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS }) }, staticCheck, onFinished)
    await service.begin('codex')
    await vi.waitFor(() => assert.equal(save.mock.calls.length, 2))
    assert.equal(staticCheck.mock.calls.length, 2)
    assert.notEqual(staticCheck.mock.calls[0]?.[3], staticCheck.mock.calls[1]?.[3])
    assert.ok(save.mock.calls[1]?.[0].checks[0]?.detail?.includes('2 attempts'))
    assert.equal(run.mock.calls.length, 1)
    await vi.waitFor(() => assert.equal(onFinished.mock.calls.length, 1))
    assert.equal(onFinished.mock.calls[0]?.[0], 'codex')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
