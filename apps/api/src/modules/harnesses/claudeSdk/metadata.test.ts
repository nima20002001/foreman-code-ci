import { afterEach, expect, it, vi } from 'vitest'
import { discoverClaudeMetadata } from './metadata.js'
import { loadOfficialClaudeSdk } from './official.js'
import { runCommand } from '../process.js'
import { ClaudeBoundedQueue } from './queue.js'
import type { ClaudeSdkClient } from './port.js'

vi.mock('./official.js', () => ({ loadOfficialClaudeSdk: vi.fn() }))
vi.mock('../process.js', () => ({ runCommand: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it('retains advertised Claude context windows without offering model input', async () => {
  const frames = new ClaudeBoundedQueue<unknown>(10)
  const offered = vi.fn()
  const query = vi.fn((input: Parameters<ClaudeSdkClient['query']>[0]) => {
    void (async () => { for await (const prompt of input.prompt) offered(prompt) })()
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
      initializationResult: async () => ({ models: [
        { value: 'default', resolvedModel: 'selected-model', contextWindow: 200000 },
        { value: 'sonnet', resolvedModel: 'selected-model', displayName: 'Selected model', contextWindow: 200000 },
        { value: 'unknown-model' },
      ], account: { apiProvider: 'firstParty', subscriptionType: 'fixture' } }),
      interrupt: async () => {}, close: () => frames.close(), joinClosed: async () => {} }
  })
  vi.mocked(loadOfficialClaudeSdk).mockResolvedValue({ sdkVersion: '0.3.284', query,
    getSessionInfo: async () => undefined, getSessionMessages: async () => [],
    forkSession: async () => ({ sessionId: 'unused' }) })
  vi.mocked(runCommand).mockResolvedValue({ stdout: '2.1.284 (Claude Code)', stderr: '', exitCode: 0 })
  const result = await discoverClaudeMetadata({ binary: '/fixture/claude', model: 'selected-model',
    profilePath: '/fixture/profile', workingDirectory: '/fixture/project',
    recovery: { root: '/fixture/runtime', owner: 'catalog' }, signal: new AbortController().signal })
  expect(result.models).toEqual([
    { id: 'selected-model', name: 'Selected model', contextWindow: 200000,
      reasoningEfforts: [], variants: [], serviceTiers: [], defaultPriority: -1 },
    { id: 'unknown-model', reasoningEfforts: [], variants: [], serviceTiers: [], defaultPriority: 2 },
  ])
  expect(query).toHaveBeenCalledOnce()
  expect(offered).not.toHaveBeenCalled()
})
