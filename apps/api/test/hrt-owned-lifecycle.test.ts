import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { describe, expect, it, vi } from 'vitest'
import type { AgentConfigurationVersion, HarnessExecutionRequest } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { deferred } from './helpers/deferred.js'

const context = {
  harness: 'codex' as const, executionId: 'execution-1', agentId: 'agent-1', workingDirectory: '/fixture',
  configuration: { id: 'config-1', prompt: { system: 'pinned' } } as unknown as AgentConfigurationVersion,
}

describe('execution allocation cleanup ownership', () => {
  it('joins concurrent disposal, retains a failed allocation, and retries only remaining owners', async () => {
    const closing = deferred()
    const first = { harness: 'codex', dispose: vi.fn(async (): Promise<void> => { await closing.promise; throw new Error('cgroup not empty') }) }
    const second = { harness: 'codex', dispose: vi.fn(async () => undefined) }
    const factory = vi.fn((input) => input.executionId === 'execution-1' ? first : second)
    const resolver = new ExecutionScopedNativeSessionManagerResolver(factory as never)
    const failed = resolver.resolve(context)
    resolver.resolve({ ...context, executionId: 'execution-2' })
    const attempt = resolver.dispose()
    expect(resolver.dispose()).toBe(attempt)
    expect(() => resolver.resolve(context)).toThrow('shutting down')
    expect(() => failed.beginStart?.()).toThrow('already starting')
    expect(() => failed.markResident?.()).toThrow('cannot become resident')
    closing.resolve()
    await expect(attempt).rejects.toThrow('disposal was incomplete')
    expect(failed.lifecycle).toBe('failed')
    first.dispose.mockResolvedValueOnce(undefined)
    await resolver.dispose()
    expect(first.dispose).toHaveBeenCalledTimes(2)
    expect(second.dispose).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('does not release a successor or make an obsolete allocation resident', () => {
    const resolver = new ExecutionScopedNativeSessionManagerResolver(() => ({ harness: 'codex' } as NativeHarnessSessionManager))
    const original = resolver.resolve(context)
    resolver.release(context, original.manager)
    const next = resolver.resolve(context)
    resolver.release(context, original.manager)
    original.markFailed?.()
    expect(() => original.beginStart?.()).toThrow('already starting')
    expect(() => original.markResident?.()).toThrow('cannot become resident')
    expect(resolver.resolve(context).manager).toBe(next.manager)
    expect(next.lifecycle).toBe('allocated')
  })

  it('pins configuration independently of caller mutation without starting a session', () => {
    const createSession = vi.fn()
    const resolver = new ExecutionScopedNativeSessionManagerResolver(() => ({ harness: 'codex', createSession } as unknown as NativeHarnessSessionManager))
    const mutable = structuredClone(context)
    resolver.resolve(mutable)
    mutable.configuration.prompt = { system: 'changed' }
    expect(() => resolver.resolve(mutable)).toThrow('cannot change')
    expect(createSession).not.toHaveBeenCalled()
  })

  it.each([false, true])('pins the complete workflow request and refuses changes (allocated before request: %s)', async (early) => {
    const request: HarnessExecutionRequest = { executionId: context.executionId, runId: 'run', workspaceId: 'workspace',
      workflowNodeId: 'node', workingDirectory: context.workingDirectory, runtimeDirectory: '/runtime',
      configuration: context.configuration, input: { accepted: true }, initialPrompt: 'accepted notice',
      executionContext: { parentRequest: null } }
    const create = vi.fn(input => {
      expect(input.workflowRequest).toEqual(early ? undefined : request)
      return { harness: 'codex', dispose: async () => undefined } as NativeHarnessSessionManager
    })
    const resolver = new ExecutionScopedNativeSessionManagerResolver(create)
    try {
      const allocated = early ? resolver.resolve(context) : undefined
      const original = resolver.resolve({ ...context, workflowRequest: request })
      if (allocated) expect(original).toBe(allocated)
      expect(resolver.resolve(context).manager).toBe(original.manager)
      expect(() => resolver.resolve({ ...context, workflowRequest: { ...request,
        executionContext: { parentRequest: { requestId: 'foreign', requesterNodeId: 'foreign' } } } }))
        .toThrow('cannot change')
      expect(() => resolver.resolve({ ...context, workflowRequest: { ...request, initialPrompt: 'changed' } }))
        .toThrow('cannot change')
      expect(create).toHaveBeenCalledOnce()
    } finally {
      await resolver.dispose()
    }
  })
})


it('passes actual Run owners through a private live getter without cloning or serializing them', async () => {
  const first = { runId: 'accepted-run', assertOwned: vi.fn() } as unknown as RunOwnership
  const next = { runId: 'accepted-run', assertOwned: vi.fn() } as unknown as RunOwnership
  let getOwner!: () => RunOwnership | undefined
  const resolver = new ExecutionScopedNativeSessionManagerResolver((input, getter) => {
    expect('owner' in input).toBe(false)
    expect(getter()).toBeUndefined() // Construction cannot mint a resident native authority.
    getOwner = getter
    return { harness: 'codex', dispose: async () => undefined } as unknown as NativeHarnessSessionManager
  })
  const resolved = resolver.resolve(context, first)
  expect(getOwner()).toBe(first)
  expect(resolver.resolve(context, next).manager).toBe(resolved.manager)
  expect(getOwner()).toBe(next)
  const wrong = { runId: 'another-run', assertOwned() {} } as unknown as RunOwnership
  expect(() => resolver.resolve(context, wrong)).toThrow('another Run owner')
  expect(getOwner()).toBe(next)
  resolver.release(context, resolved.manager)
  expect(getOwner()).toBeUndefined()
  resolver.resolve(context, first)
  expect(getOwner()).toBe(first)
  await resolver.dispose()
  expect(getOwner()).toBeUndefined()
})

it('adopts a cleanup owner only for the already allocated manager and same Run', () => {
  const first = { runId: 'run', assertOwned: vi.fn() } as unknown as RunOwnership
  const next = { runId: 'run', assertOwned: vi.fn() } as unknown as RunOwnership
  let getOwner!: () => RunOwnership | undefined
  const create = vi.fn((_context, getter) => {
    getOwner = getter
    return { harness: 'codex' } as NativeHarnessSessionManager
  })
  const resolver = new ExecutionScopedNativeSessionManagerResolver(create)
  const original = resolver.resolve({ ...context, runId: 'run' }, first)
  resolver.adoptOwner(context.executionId, original.manager, next)
  expect(getOwner()).toBe(next)
  expect(create).toHaveBeenCalledOnce()
  expect(() => resolver.adoptOwner('missing', original.manager, next)).toThrow('does not belong')
  expect(() => resolver.adoptOwner(context.executionId, {} as NativeHarnessSessionManager, next)).toThrow('does not belong')
  expect(() => resolver.adoptOwner(context.executionId, original.manager, { ...next, runId: 'other' } as RunOwnership))
    .toThrow('does not belong')
  expect(getOwner()).toBe(next)
  expect(create).toHaveBeenCalledOnce()
})
