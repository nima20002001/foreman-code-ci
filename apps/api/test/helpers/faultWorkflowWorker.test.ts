import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { input } from '../fixtures/codex-test-helpers.js'
import { faultWorkflowWorker } from './faultWorkflowWorker.js'

it('reopens the Worker journal without waiting for Main to send another request', async () => {
  const scratch = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'workflow-restart-'))
  const worker = await faultWorkflowWorker(directory)
  try {
    const before = { ...worker.connection }
    const incarnationId = worker.incarnationId
    await worker.restart()
    expect(worker.connection).toMatchObject({
      ...before, bootId: expect.any(String), connectionGeneration: before.connectionGeneration + 1,
    })
    expect(worker.connection.bootId).not.toBe(before.bootId)
    expect(worker.incarnationId).not.toBe(incarnationId)
    expect(worker.methods).toEqual([])
    expect(await worker.journal.status('unsubmitted-operation')).toMatchObject({ status: 'unknown' })
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['session', 'turn'] as const)('runs a scoped workflow with correlation supplied at %s creation', async binding => {
  const scratch = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'workflow-replay-'))
  const worker = await faultWorkflowWorker(directory)
  const manager = worker.manager()
  const controller = new AbortController()
  let settled: Promise<unknown> | undefined
  try {
    const source = input(directory)
    const correlationId = `execution:${source.request.executionId}`
    let session: NativeSessionReference | undefined
    const events: string[] = []
    const stream = (async () => {
      session = await manager.createSession({ ...source, ...(binding === 'session' ? { correlationId } : {}) })
      for await (const event of manager.startTurn(session, {
        clientCorrelationId: correlationId, prompt: 'Complete the task.',
      }, controller.signal)) events.push(event.type)
    })()
    settled = Promise.allSettled([stream])
    await Promise.race([vi.waitFor(() => expect(worker.replay.starts).toHaveLength(1)), stream])
    const turn = worker.replay.starts[0]!
    worker.replay.complete(turn.sessionId, turn.nativeTurnId, 'complete')
    await stream
    expect(events).toContain('turn.completed')
    expect(session).toBeDefined()
    expect((await manager.history(session!)).terminalResult).toMatchObject({ outcome: 'succeeded' })
  } finally {
    controller.abort()
    await settled
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('holds the native turn until an unavailable MCP catalog recovers', async () => {
  const scratch = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'workflow-replay-'))
  const worker = await faultWorkflowWorker(directory, { mcpUnavailable: true })
  const manager = worker.manager()
  const controller = new AbortController()
  let settled: Promise<unknown> | undefined
  try {
    const source = input(directory)
    source.request.workingDirectory = '/worker/project'
    const session = await manager.createSession(source)
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const stream = (async () => {
      for await (const event of manager.startTurn(session, {
        clientCorrelationId: `execution:${source.request.executionId}`, prompt: 'Complete the task.',
      }, controller.signal)) events.push(event)
    })()
    settled = Promise.allSettled([stream])
    await Promise.race([vi.waitFor(() =>
      expect(events.some(event => event.type === 'turn.mcp_startup_retry')).toBe(true)), stream])
    expect(worker.replay.starts).toHaveLength(0)
    const retry = events.find(event => event.type === 'turn.mcp_startup_retry')!
    expect(retry.payload).toMatchObject({ attempt: 2, delayMs: 10_000 })
    worker.makeMcpReady()
    await vi.waitFor(() => expect(worker.advanceNativeTimer(Number(retry.payload.delayMs))).toBe(true))
    await vi.waitFor(() => expect(worker.replay.starts).toHaveLength(1))
    worker.replay.complete(session.nativeSessionId, worker.replay.starts[0]!.nativeTurnId, 'complete')
    await stream
    expect((await manager.history(session)).terminalResult).toMatchObject({ outcome: 'succeeded' })
  } finally {
    controller.abort()
    await settled
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})
