import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { qualifyCodexOutputProtection } from '../src/modules/harnesses/codexOutputProtection.js'
import { qualifyCodex } from '../src/modules/harnesses/codexProtocol.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import { inheritedAgentEnvironment } from '../src/modules/harnesses/secrets.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { DomainError } from '../src/modules/errors.js'

const enabled = process.env.NIM2691_REAL_NATIVE === '1'

describe.skipIf(!enabled)('original native output store protection', () => {
  it('proves that the selected native actor and its descendant cannot write the private output store', async () => {
    const directory = await mkdtemp('/var/tmp/native-output-qualification-')
    const workspace = join(directory, 'workspace')
    const protectedDirectory = join(directory, 'private')
    await mkdir(workspace, { mode: 0o700 })
    await mkdir(protectedDirectory, { mode: 0o700 })
    const registry = new NativeProcessRegistry(join(directory, 'processes'))
    const admission = await registry.reserveLaunch('output-test-installation-read')
    const signal = AbortSignal.timeout(120_000)
    let failure: { error: unknown } | undefined
    const cleanup = async () => {
      await registry.abandonReservedLaunch(admission)
      if (!await registry.closeOwner(admission.owner)) throw new Error('Native qualification owner did not close.')
      await rm(directory, { recursive: true, force: true })
    }
    try {
      const environment = inheritedAgentEnvironment()
      const qualified = await qualifyCodex(process.env.CODEX_BINARY ?? 'codex', workspace,
        environment, true, signal, admission)
      await registry.abandonReservedLaunch(admission)
      expect(await registry.closeOwner(admission.owner)).toBe(true)
      await qualifyCodexOutputProtection({ qualification: {
        configuration: { harness: 'codex', model: process.env.CODEX_TEST_MODEL ?? 'gpt-5.6-luna', reasoningEffort: 'medium',
          sandbox: 'workspace-write', serviceTier: 'standard' },
        binary: qualified.binary, binaryIdentity: qualified.identity, providerVersion: qualified.providerVersion,
        schemaIdentity: qualified.schemaManifestSha256,
        expectedSandbox: { cwd: workspace, writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: environment.TMPDIR },
      }, protectedDirectory, registry, qualify: qualifyCodex, command: runCommand,
      assertCurrent: async (bounded) => { bounded.throwIfAborted() }, signal })
      expect(await readdir(protectedDirectory)).toEqual([])
      expect(await readdir(workspace)).toEqual([])
      expect(registry.snapshot().launches.every((launch) => launch.lifecycle === 'closed')).toBe(true)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'WORKER_NATIVE_OUTPUT_PROTECTION_FAILED' && error.details) {
        console.error('Native sandbox probe diagnostics:', JSON.stringify(error.details))
      }
      failure = { error }
      throw error
    } finally {
      await cleanup().catch((error: unknown) => {
        if (failure) throw new AggregateError([failure.error, error],
          'Native qualification and cleanup both failed.', { cause: error })
        throw error
      })
    }
  }, 180000)
})
