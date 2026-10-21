import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { CodexRuntimeFileTurn } from '../src/modules/harnesses/codexFiles/runtime.js'
import type { CodexFileTurn } from '../src/modules/harnesses/codexFiles/turn.js'
import type { CodexFileCallResult } from '../src/modules/harnesses/codexFiles/port.js'
import { deferred } from './helpers/deferred.js'

const accepted = { threadId: 'thread-a', turnId: 'turn-a', callId: 'call-a', tool: 'files_publish_result',
  arguments: { commandId: 'command-a', artifactId: 'artifact-a' } }
const success = (): CodexFileCallResult => ({ success: true, contentItems: [{ type: 'inputText', text: '{"ready":true}' }] })
function stub(overrides: Partial<Pick<CodexFileTurn, 'activate' | 'call' | 'close'>> = {}) {
  return { activate: async () => undefined, call: async () => success(), close: async () => undefined, ...overrides } as unknown as CodexFileTurn
}

describe('FIL-08a executable file registration', () => {
  it('has no executable authority before activation, or after close', async () => {
    let calls = 0
    const turn = new CodexRuntimeFileTurn(stub({ call: async () => { calls++; return success() } }), 'thread-a')
    assert.equal((await turn.dispatch(accepted)).success, false)
    await turn.activate('turn-a')
    assert.equal((await turn.dispatch(accepted)).success, true)
    await turn.close()
    assert.equal(turn.closed, true)
    assert.equal((await turn.dispatch(accepted)).success, false)
    assert.equal(calls, 1)
  })

  it('fences thread and turn ownership before receipt lookup', async () => {
    let calls = 0
    const turn = new CodexRuntimeFileTurn(stub({ call: async () => { calls++; return success() } }), 'thread-a')
    await turn.activate('turn-a')
    await turn.dispatch(accepted)
    assert.equal((await turn.dispatch({ ...accepted, threadId: 'thread-b' })).success, false)
    assert.equal((await turn.dispatch({ ...accepted, turnId: 'turn-b' })).success, false)
    assert.equal((await turn.dispatch({ ...accepted, callId: '' })).success, false)
    assert.equal(calls, 1)
    await turn.close()
  })

  it('coalesces concurrent equivalent calls and rejects changed input under a call ID', async () => {
    const release = deferred()
    let calls = 0
    const turn = new CodexRuntimeFileTurn(stub({ call: async () => { calls++; await release.promise; return success() } }), 'thread-a')
    await turn.activate('turn-a')
    const first = turn.dispatch(accepted)
    const replay = turn.dispatch({ ...accepted, arguments: { artifactId: 'artifact-a', commandId: 'command-a' } })
    const conflict = await turn.dispatch({ ...accepted, arguments: { ...accepted.arguments, artifactId: 'foreign' } })
    assert.equal(conflict.success, false)
    release.resolve()
    assert.deepEqual(await first, await replay)
    assert.equal(calls, 1)
    await turn.close()
  })

  it('close racing token issuance never reopens registration', async () => {
    const release = deferred()
    let live = false, calls = 0
    const activation = release.promise.then(() => { live = true })
    const turn = new CodexRuntimeFileTurn(stub({
      activate: () => activation,
      call: async () => { calls++; return success() },
      close: async () => { await activation; live = false },
    }), 'thread-a')
    const activating = turn.activate('turn-a')
    const closing = turn.close()
    assert.equal(turn.closed, true)
    assert.equal((await turn.dispatch(accepted)).success, false)
    release.resolve()
    await Promise.all([activating, closing])
    assert.equal(live, false)
    assert.equal((await turn.dispatch(accepted)).success, false)
    assert.equal(calls, 0)
  })

  it('keeps failed cleanup fenced but permits an explicit cleanup retry', async () => {
    let closes = 0, calls = 0
    const turn = new CodexRuntimeFileTurn(stub({
      close: async () => { if (++closes === 1) throw new Error('revocation unavailable') },
      call: async () => { calls++; return success() },
    }), 'thread-a')
    await turn.activate('turn-a')
    await assert.rejects(turn.close(), /revocation unavailable/)
    assert.equal((await turn.dispatch(accepted)).success, false)
    await turn.close()
    assert.equal(closes, 2)
    assert.equal(calls, 0)
  })

  it('bounds retained responses and never leaks service exceptions', async () => {
    const turn = new CodexRuntimeFileTurn(stub({ call: async () => ({ success: true,
      contentItems: [{ type: 'inputText', text: 'x'.repeat(300 * 1024) }],
    }) }), 'thread-a')
    await turn.activate('turn-a')
    assert.equal((await turn.dispatch(accepted)).success, false)
    await turn.close()
    const failing = new CodexRuntimeFileTurn(stub({ call: async () => { throw new Error('secret-token-must-not-escape') } }), 'thread-a')
    await failing.activate('turn-a')
    const result = await failing.dispatch(accepted)
    assert.equal(result.success, false)
    assert(!JSON.stringify(result).includes('secret-token'))
    await failing.close()
  })
})
