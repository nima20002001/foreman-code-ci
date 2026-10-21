import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { FixtureProcessClosures } from './helpers/eng06ProcessClosures.js'

// The helper itself must not make the PG recovery assertions pass with fake
// physical evidence. These tests need Node child processes, not PostgreSQL.
describe('ENG06-C task-owned process closure fixture', () => {
  it('does not turn an empty registry or a foreign execution into a positive receipt', async () => {
    const processes = new FixtureProcessClosures()
    try {
      assert.equal(await processes.recover('missing', AbortSignal.timeout(5000)), false)
      await processes.start('execution-a', 'session-a')
      assert.equal(await processes.recover('execution-b', AbortSignal.timeout(5000)), false)
      assert.equal(processes.isClosed('execution-a'), false)
      assert.deepEqual(processes.recoveredExecutions, [])
    } finally { await processes.close() }
  })

  it('closes only the registered original child and reuses its exit without a new launch', async () => {
    const processes = new FixtureProcessClosures()
    try {
      await processes.start('execution-a', 'session-a')
      await processes.start('execution-b', 'session-b')
      assert.equal(await processes.recover('execution-a', AbortSignal.timeout(5000)), true)
      assert.equal(processes.isClosed('execution-a'), true)
      assert.equal(processes.isClosed('execution-b'), false)
      assert.equal(await processes.recover('execution-a', AbortSignal.timeout(5000)), true)
      assert.deepEqual(processes.startedExecutions, ['execution-a', 'execution-b'])
    } finally { await processes.close() }
  })

  it('retains a positive original-session close across coordinator reconstruction', async () => {
    const processes = new FixtureProcessClosures()
    try {
      await processes.start('execution-a', 'session-a')
      await processes.closeSession('session-a')
      const recoveredPort = (id: string, signal: AbortSignal) => processes.recover(id, signal)
      assert.equal(await recoveredPort('execution-a', AbortSignal.timeout(5000)), true)
      assert.deepEqual(processes.startedExecutions, ['execution-a'])
      await assert.rejects(processes.closeSession('different-session'))
    } finally { await processes.close() }
  })

  it('does not acknowledge an aborted recovery or rebind an existing execution/session', async () => {
    const processes = new FixtureProcessClosures()
    try {
      await processes.start('execution-a', 'session-a')
      await assert.rejects(processes.recover('execution-a', AbortSignal.abort(new Error('owner lost'))), /owner lost/)
      assert.equal(processes.isClosed('execution-a'), false)
      assert.deepEqual(processes.recoveredExecutions, [])
      await assert.rejects(processes.start('execution-a', 'session-new'), /cannot be reused/)
      await assert.rejects(processes.start('execution-new', 'session-a'), /cannot be reused/)
      assert.deepEqual(processes.startedExecutions, ['execution-a'])
    } finally { await processes.close() }
  })
})
