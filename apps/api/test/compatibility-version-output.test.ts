import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeCompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'
import { spawnNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

vi.mock('../src/modules/harnesses/recovery/processRegistry.js', async original => ({
  ...await original<typeof import('../src/modules/harnesses/recovery/processRegistry.js')>(),
  spawnNativeProcess: vi.fn(),
  stopRecoveredChild: vi.fn(async () => true),
  nativeProcessExit: vi.fn((_child, result) => result),
}))

afterEach(() => vi.clearAllMocks())

function versionProcess(output: 'stdout' | 'stderr'): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
  })
  let closedStreams = 0
  for (const stream of [child.stdout, child.stderr]) {
    stream.once('close', () => {
      if (++closedStreams === 2) child.emit('close', 0, null)
    })
  }
  child.stdin.once('finish', () => {
    child[output].write('codex-cli 0.')
    child.exitCode = 0
    child.emit('exit', 0, null)
    // A native exit can be observed before the final pipe bytes reach the reader.
    setImmediate(() => {
      if (!child[output].destroyed) child[output].end('154.0\n')
      const other = output === 'stdout' ? child.stderr : child.stdout
      if (!other.destroyed) other.end()
    })
  })
  return child as unknown as ChildProcessWithoutNullStreams
}

it.each(['stdout', 'stderr'] as const)(
  'reads the complete CLI version from %s when native exit precedes readable EOF', async output => {
    const directory = await privateFixtureDirectory('compatibility-version-output-')
    const binary = join(directory, 'codex')
    await writeFile(binary, 'diagnostic fixture', { mode: 0o700 })
    vi.mocked(spawnNativeProcess).mockReturnValueOnce(versionProcess(output))
    const probe = nativeCompatibilityProbe({ codex: binary }, directory)
    try {
      const installed = await probe.inspect('codex', new AbortController().signal)
      expect(installed.version).toBe('0.154.0')
      await probe.assertUnchanged(installed, new AbortController().signal)
    } finally {
      await probe.close?.()
      await removeFixtureDirectory(directory)
    }
  },
)
