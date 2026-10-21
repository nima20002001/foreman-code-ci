import { rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { childHistoryCursor, encodeChildHistoryCursor } from './nativeReadback.js'
import { createClaudeSdkRunner } from '../harnesses/claudeSdk/runner.js'
import type { ClaudeSdkClient } from '../harnesses/claudeSdk/port.js'
import { calls, fixture, fixtureQualification, input } from '../../../test/fixtures/codex-test-helpers.js'

// These are unit transport fixtures, never native qualification evidence.
vi.doMock('../harnesses/codexProtocol.js', async () => {
  const original = await vi.importActual<typeof import('../harnesses/codexProtocol.js')>('../harnesses/codexProtocol.js')
  return { ...original, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
const { CodexAppServerSessionManager } = await import('../harnesses/codexAppServer.js')
const { CodexStdioTransport } = await import('../harnesses/codexStdioTransport.js')

describe('exact parent native child history readers', () => {
  it('binds every opaque cursor to the original root', () => {
    const cursor = encodeChildHistoryCursor({ root: 'root', target: 'child', cursor: 'page' })
    expect(childHistoryCursor('root', cursor)).toMatchObject({ target: 'child', cursor: 'page' })
    expect(() => childHistoryCursor('foreign', cursor)).toThrow('original parent')
  })
  it('reads Claude helpers only for exact parent, profile, directory and listed agent, without query/offer', async () => {
    const scope = { deviceId: 'main', profilePath: '/owned/profile', configRevision: '1', cwd: '/owned/project' }
    const query = vi.fn(() => { throw new Error('Readback must never launch an inference query') })
    const get = vi.fn(async () => [{ type: 'user', uuid: 'm', session_id: 'root', parent_tool_use_id: 'spawn', parent_agent_id: null, message: { content: 'CHILD INPUT' } }])
    const client: ClaudeSdkClient = { sdkVersion: '0.3.284', query, getSessionInfo: async () => ({ sessionId: 'root' }),
      getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'fork' }), listSubagents: async () => ['agent'], getSubagentMessages: get }
    const runner = createClaudeSdkRunner({ loadClient: async () => client })
    try {
      const page = await runner.subagentHistory!({ ...scope, nativeSessionId: 'root' }, scope)
      expect(page).toMatchObject({ agentId: 'agent', hasMore: false })
      expect(get).toHaveBeenCalledWith('root', 'agent', { dir: scope.cwd, limit: 51, offset: 0 })
      await expect(runner.subagentHistory!({ ...scope, nativeSessionId: 'root' }, scope, 'foreign')).rejects.toThrow('exact parent')
      await expect(runner.subagentHistory!({ ...scope, nativeSessionId: 'root' }, { ...scope, profilePath: '/foreign' })).rejects.toThrow('profilePath mismatch')
      expect(query).not.toHaveBeenCalled()
    } finally { await runner.dispose() }
  })
  it('reads Codex child items only after native ancestry proof and never resumes or starts a child turn', async () => {
    const f = await fixture()
    let mismatched = false, rootId = ''
    class ReadbackTransport extends CodexStdioTransport {
      override async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
        if (method === 'thread/items/list') return { data: [{ turnId: 'turn', item: params.threadId === 'child'
          ? { type: 'agentMessage', id: 'm', text: 'CHILD CODEX' }
          : { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker' } }], nextCursor: null, backwardsCursor: null }
        if (method === 'thread/read' && params.threadId === 'child') return { thread: { id: 'child', parentThreadId: mismatched ? 'foreign' : rootId, ephemeral: false,
          source: { subAgent: { thread_spawn: { parent_thread_id: rootId } } } } }
        return super.request(method, params, signal)
      }
    }
    const native = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'scoped', undefined,
      { mode: 'native', transport: (...args) => new ReadbackTransport(...args) })
    try {
      const root = await native.createSession(input(f.directory))
      rootId = root.nativeSessionId
      const first = await native.subagentHistory(root)
      expect(first.nextCursor).not.toBeNull()
      const child = await native.subagentHistory(root, first.nextCursor!)
      expect(JSON.stringify(child.events)).toContain('CHILD CODEX')
      expect((await calls(f.directory)).filter(call => ['thread/resume', 'turn/start', 'turn/steer'].includes(String((call.wire as { method?: string } | undefined)?.method)))).toEqual([])
      mismatched = true
      await expect(native.subagentHistory(root, first.nextCursor!)).rejects.toThrow('exact durable child ancestry')
    } finally { await native.shutdown(); await rm(f.directory, { recursive: true, force: true }) }
  }, 10000)
})
