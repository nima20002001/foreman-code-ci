import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { it } from 'vitest'
import { recoverPersistedClaudeCompaction } from '../src/modules/harnesses/claudeSdk/recoverCompaction.js'
import { identityAlive, processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { NativeProcessRegistry, nativeProcessExit, spawnNativeProcess, stopRecoveredChild } from '../src/modules/harnesses/recovery/processRegistry.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

const outputCases = [
  { provider: 'claude', paddingBytes: 384 * 1024,
    name: 'drains backpressured claude final frames before guardian closure' },
  { provider: 'codex', paddingBytes: 384 * 1024,
    name: 'drains backpressured codex final frames before guardian closure' },
  { provider: 'claude', paddingBytes: 2 * 1024 * 1024,
    name: 'drains claude final frames larger than the relay pipe capacity before guardian closure' },
] as const

for (const { provider, paddingBytes, name } of outputCases) it(
  name, async () => {
    const root = await privateFixtureDirectory('guardian-output-')
    const registry = new NativeProcessRegistry(root)
    const owner = 'output-fixture'
    const recovery = await registry.reserveLaunch(owner)
    const sessionId = randomUUID()
    const promptUuid = randomUUID()
    const scope = { deviceId: 'fixture-device', profilePath: root, configRevision: 'fixture-revision', cwd: root }
    const frames = [
      { type: 'system', subtype: 'init', session_id: sessionId },
      { type: 'assistant', session_id: sessionId, padding: 'x'.repeat(paddingBytes) },
      { type: 'system', subtype: 'compact_boundary', session_id: sessionId,
        compact_metadata: { trigger: 'manual' } },
      { type: 'result', session_id: sessionId, user_message_uuid: promptUuid,
        is_error: false, subtype: 'success', result: 'final-result' },
    ]
    const expected = frames.map(frame => JSON.stringify(frame) + '\n').join('')
    const inputFrames = frames.map(frame => frame.padding ? { ...frame, padding: frame.padding.length } : frame)
    const child = spawnNativeProcess(process.execPath, ['-e', `
      const fs = require('node:fs')
      require('node:readline').createInterface({input:process.stdin}).once('line', () => {
        const frames = JSON.parse(process.argv[1])
        for (const frame of frames) if (typeof frame.padding === 'number') frame.padding = 'x'.repeat(frame.padding)
        fs.writeSync(1, frames.map(frame => JSON.stringify(frame) + '\\n').join(''))
        fs.writeSync(2, 'final-stderr\\n')
        process.exit(0)
      })
    `, JSON.stringify(inputFrames)], { cwd: root, env: {}, recovery,
      ...(provider === 'claude' ? { claudeSessionScope: scope } : { restartDetachable: true, reconnectableStdio: true }) })
    const closed = once(child, 'close')
    const outputReady = once(child.stdout, 'readable')
    const receipt = new Promise<void>(resolve => child.on('message', message => {
      if ((message as { operation?: string }).operation === 'native_exit') resolve()
    }))
    const stderr: Buffer[] = []
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.stdin.write(JSON.stringify({ type: 'user', uuid: promptUuid, message: { content: '/compact' } }) + '\n')
    try {
      // Let output buffer, then drain it so backpressure cannot prevent provider exit.
      await outputReady
      const stdout: Buffer[] = []
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stdout.resume()
      await receipt
      const [exitCode, exitSignal] = await closed
      assert.equal(Buffer.concat(stdout).toString(), expected)
      assert.equal(Buffer.concat(stderr).toString(), 'final-stderr\n')
      assert.deepEqual(nativeProcessExit(child, { exitCode, exitSignal }), { exitCode: 0, exitSignal: null })
      if (provider === 'claude') {
        const recovered = await recoverPersistedClaudeCompaction({ requestId: 'pending',
          nativeRequestId: promptUuid, nativeSessionId: sessionId, nativeOperationId: null,
          claudeSession: scope, status: 'uncertain', message: 'Read to recover', beforeTokens: null,
          observedAt: new Date().toISOString() })
        assert.equal(recovered.status, 'completed')
      }
      assert.equal(await registry.closeOwner(owner), true)
    } finally {
      await stopRecoveredChild(child)
      assert.equal(await registry.closeOwner(owner), true)
      await removeFixtureDirectory(root)
    }
  }, 20_000,
)

it('bounds relay draining when a descendant retains the provider pipe', async () => {
  const root = await privateFixtureDirectory('guardian-descendant-')
  const registry = new NativeProcessRegistry(root)
  const owner = 'descendant-fixture'
  const child = spawnNativeProcess(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: ['ignore', process.stdout, process.stderr] })
    console.log(JSON.stringify({pid:descendant.pid}))
    descendant.unref()
    process.exit(0)
  `], { cwd: root, env: {}, recovery: await registry.reserveLaunch(owner), restartDetachable: true, reconnectableStdio: true })
  const closed = once(child, 'close')
  const stdout: Buffer[] = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.resume()
  try {
    const [exitCode, exitSignal] = await closed
    assert.deepEqual(nativeProcessExit(child, { exitCode, exitSignal }), { exitCode: 0, exitSignal: null })
    const pid = (JSON.parse(Buffer.concat(stdout).toString()) as { pid: number }).pid
    const descendant = processIdentity(pid)
    assert.ok(!descendant || !identityAlive(descendant))
    assert.equal(await registry.closeOwner(owner), true)
  } finally {
    await stopRecoveredChild(child)
    assert.equal(await registry.closeOwner(owner), true)
    await removeFixtureDirectory(root)
  }
}, 15_000)
