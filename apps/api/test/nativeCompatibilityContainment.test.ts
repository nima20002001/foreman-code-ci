import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { nativeCompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'

const diagnostic = vi.hoisted(() => ({
  stderr: 'Native launch refused: delegated cgroup v2 with cgroup.kill is required.\nprivate-value',
  delivery: 'before-handoff' as 'before-handoff' | 'after-exit',
}))

vi.mock('../src/modules/harnesses/process.js', async () => {
  const { PassThrough } = await import('node:stream')
  return {
    spawnOwnedStdioProcess: () => {
      const child = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }
      const output = () => {
        child.stderr.end(diagnostic.stderr)
        child.stdout.end()
      }
      const closed = Promise.resolve().then(() => {
        if (diagnostic.delivery === 'after-exit') setImmediate(output)
        else output()
        return { exitCode: null, exitSignal: 'SIGKILL' }
      })
      return { child, closed, close: async () => { await closed } }
    },
  }
})

it.each(['before-handoff', 'after-exit'] as const)(
  'reports refused native containment with %s output without blaming the CLI or exposing diagnostic output', async delivery => {
    diagnostic.delivery = delivery
    const directory = await mkdtemp(join(tmpdir(), 'native-diagnostic-'))
    const binary = join(directory, 'codex')
    await writeFile(binary, `#!${process.execPath}\n`, { mode: 0o700 })
    const probe = nativeCompatibilityProbe({ codex: binary }, directory, process.env, 5_000, {
      recovery: { root: directory, owner: 'diagnostic-fixture' },
      beforeCommand: async () => {},
    })
    try {
      await expect(probe.inspect('codex', new AbortController().signal)).rejects.toMatchObject({
        code: 'NATIVE_CONTAINMENT_UNAVAILABLE',
        message: 'Native diagnostics require a delegated cgroup v2 with cgroup.kill. '
          + 'Run the application or tests in their delegated service or scope and retry.',
      })
    } finally {
      await probe.close?.()
      await rm(directory, { recursive: true, force: true })
    }
  })
