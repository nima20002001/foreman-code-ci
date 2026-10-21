import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { HostBoundExecutionManagers } from './nativeComposition.js'
import { readAcceptedPlacement, readDispatchIntent } from './persistence.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { HarnessExecution } from '@foreman-code/contracts'

vi.mock('./persistence.js', () => ({ readAcceptedPlacement: vi.fn(), readDispatchIntent: vi.fn() }))
const pool = {} as pg.Pool
const execution = { id: 'execution', runId: 'run', workflowNodeId: 'node', workingDirectory: '/project' } as HarnessExecution
const native = { harness: 'codex' } as NativeHarnessSessionManager
const context = { executionId: 'execution', agentId: 'agent', harness: 'codex' as const, workingDirectory: '/project', configuration: { id: 'configuration' } } as Parameters<HostBoundExecutionManagers['resolve']>[0]
describe('accepted host manager composition', () => {
  it('does not allocate before exact durable binding preparation', () => {
    const local = vi.fn(() => native), remote = vi.fn(() => native)
    const managers = new HostBoundExecutionManagers('main', pool, { getExecution: async () => execution }, local, remote)
    expect(() => managers.resolve(context)).toThrow('Load the exact execution binding')
    expect(local).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled()
  })
  it('preserves original unplaced local behavior after preload', async () => {
    vi.mocked(readDispatchIntent).mockResolvedValue(undefined); vi.mocked(readAcceptedPlacement).mockResolvedValue(undefined)
    const local = vi.fn(() => native), remote = vi.fn(() => native)
    const managers = new HostBoundExecutionManagers('main', pool, { getExecution: async () => execution }, local, remote)
    expect(await managers.prepare('execution')).toBeNull()
    expect(managers.resolve(context).manager).toBe(native)
    expect(managers.resolve(context).manager).toBe(native)
    expect(local).toHaveBeenCalledTimes(1); expect(remote).not.toHaveBeenCalled()
  })
  it('rejects a placed execution without its original committed intent', async () => {
    vi.mocked(readDispatchIntent).mockResolvedValue(undefined)
    vi.mocked(readAcceptedPlacement).mockResolvedValue({ bindingHash: 'pin' } as NonNullable<Awaited<ReturnType<typeof readAcceptedPlacement>>>)
    const local = vi.fn(() => native), remote = vi.fn(() => native)
    await expect(new HostBoundExecutionManagers('main', pool, { getExecution: async () => execution }, local, remote).prepare('execution')).rejects.toMatchObject({ code: 'PLACEMENT_BINDING_CONFLICT' })
    expect(local).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled()
  })
})
