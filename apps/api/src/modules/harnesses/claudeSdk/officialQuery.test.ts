import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { NativeProcessRegistry } from '../recovery/processRegistry.js'
import { ownedClaudeSdkQueries } from './official.js'
import type { ClaudeSdkClient } from './port.js'
import { createClaudeSdkRunner } from './runner.js'
import type { ClaudeSdkQuery } from './port.js'

it('persists no-start closure when SDK dispatch throws before native spawn, including fresh-registry recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-query-start-'))
  const registry = new NativeProcessRegistry(root)
  let deferredSpawn: Options['spawnClaudeCodeProcess']
  const sdkQuery = vi.fn(({ options }: { options?: Options }) => {
    deferredSpawn = options?.spawnClaudeCodeProcess
    throw new Error('SDK query failed before spawn')
  })
  const owned = ownedClaudeSdkQueries({ sdk: { query: sdkQuery }, recovery: registry.scope('query-owner'),
    binary: '/unused-claude' })
  const client: ClaudeSdkClient = { sdkVersion: '0.3.284', ...owned,
    getSessionInfo: async sessionId => ({ sessionId }), getSessionMessages: async () => [],
    forkSession: async () => ({ sessionId: 'unused' }) }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  try {
    expect(await registry.closeOwner('query-owner')).toBe(false)
    await expect(runner.open({ scope: { deviceId: 'test', profilePath: root, cwd: root, configRevision: '1' },
      options: {} })).rejects.toThrow('SDK query failed before spawn')
    expect(sdkQuery).toHaveBeenCalledTimes(1)
    expect(runner.requiresRuntimeClosure!()).toBe(false)
    expect(await new NativeProcessRegistry(root).closeOwner('query-owner')).toBe(true)
    expect(() => deferredSpawn!({ command: '/unused-claude', args: [], cwd: root,
      env: {}, signal: new AbortController().signal })).toThrow('closed before native launch')
  } finally {
    await runner.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('joins a query returned after startup cancellation before releasing its opening session', async () => {
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  let finish!: (query: ClaudeSdkQuery) => void
  const query = new Promise<ClaudeSdkQuery>(resolve => { finish = resolve })
  const close = vi.fn()
  const joinClosed = vi.fn(async () => {})
  const client: ClaudeSdkClient = { sdkVersion: '0.3.284',
    query: () => { enter(); return query }, getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'unused' }) }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  const controller = new AbortController()
  const opening = runner.open({ scope: { deviceId: 'test', profilePath: '/profile', cwd: '/work', configRevision: '1' },
    options: {}, signal: controller.signal })
  const failed = expect(opening).rejects.toThrow('Startup canceled')
  try {
    await entered
    controller.abort(new Error('Startup canceled'))
    finish({ async *[Symbol.asyncIterator]() {}, interrupt: async () => {}, close, joinClosed })
    await failed
    expect(close).toHaveBeenCalledTimes(1)
    expect(joinClosed).toHaveBeenCalledTimes(1)
  } finally { await runner.dispose() }
})
