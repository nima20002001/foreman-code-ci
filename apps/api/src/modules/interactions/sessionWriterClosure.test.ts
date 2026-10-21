import { expect, it } from 'vitest'
import type { NativeSessionLane, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { PostgresInteractionCoordinationRepository } from './coordination.js'
import { SingleWriterSessionManager } from './sessionWriter.js'

const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'continued-thread' }

function fixture(close: () => Promise<void>) {
  let lane: NativeSessionLane = { id: 'writer-lane', harness: 'codex', nativeSessionId: session.nativeSessionId,
    ownerAgentId: 'workflow-agent', observedStatus: 'idle', revision: 1, connectionGeneration: 0,
    observedAt: new Date().toISOString(), correlationId: 'execution:previous', currentTurnOrMessageId: 'previous-turn' }
  const assertLease = async (_id: string, token: string) => {
    expect(lane.leaseToken).toBe(token)
    expect(Date.parse(lane.leaseExpiresAt!)).toBeGreaterThan(Date.now())
  }
  const coordination = {
    ensureLane: async () => structuredClone(lane),
    getLane: async () => structuredClone(lane),
    claimLane: async (_id: string, revision: number, owner: string, token: string, expiresAt: string) => {
      expect(revision).toBe(lane.revision)
      expect(lane.leaseToken).toBeUndefined()
      lane = { ...lane, revision: revision + 1, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expiresAt }
      return structuredClone(lane)
    },
    assertLaneLease: assertLease,
    renewLane: async (id: string, token: string, duration: number) => {
      await assertLease(id, token)
      return lane.leaseExpiresAt = new Date(Date.now() + duration).toISOString()
    },
    releaseLane: async (id: string, token: string,
      observed: Pick<NativeSessionLane, 'observedStatus' | 'currentTurnOrMessageId'>) => {
      await assertLease(id, token)
      lane = { ...lane, revision: lane.revision + 1, observedStatus: observed.observedStatus,
        currentTurnOrMessageId: observed.currentTurnOrMessageId,
        correlationId: observed.observedStatus === 'idle' && !observed.currentTurnOrMessageId
          ? undefined : lane.correlationId,
        leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined }
      return structuredClone(lane)
    },
  }
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected native operation during closure') }
  const native: NativeHarnessSessionManager = { harness: 'codex', close, closeForRestart: close,
    capabilities: unexpected, inspectMcp: unexpected, createSession: unexpected, attachSession: unexpected,
    pending: unexpected, respond: unexpected, cancel: unexpected, history: unexpected, reconcile: unexpected,
    startTurn: () => { throw new Error('Unexpected native turn during closure') } }
  const writer = new SingleWriterSessionManager(native,
    coordination as unknown as PostgresInteractionCoordinationRepository, 'workflow-agent')
  return { writer, lane: () => structuredClone(lane) }
}

it('clears the completed identity only after its native process confirms closure', async () => {
  let finish!: () => void
  let began!: () => void
  const entered = new Promise<void>(resolve => { began = resolve })
  const completion = new Promise<void>(resolve => { finish = resolve })
  const f = fixture(async () => { began(); await completion })
  const closing = f.writer.close(session)
  await entered
  expect(f.lane()).toMatchObject({ correlationId: 'execution:previous', currentTurnOrMessageId: 'previous-turn' })
  finish()
  await closing
  expect(f.lane().observedStatus).toBe('idle')
  expect(f.lane().correlationId).toBeUndefined()
  expect(f.lane().currentTurnOrMessageId).toBeUndefined()
  expect(f.lane().leaseToken).toBeUndefined()
})

it.each(['failed close', 'restart detachment'] as const)('preserves the exact identity after %s', async mode => {
  const failure = new Error('Original native closure is unconfirmed')
  const f = fixture(async () => { if (mode === 'failed close') throw failure })
  if (mode === 'failed close') await expect(f.writer.close(session)).rejects.toBe(failure)
  else await f.writer.closeForRestart(session)
  expect(f.lane()).toMatchObject({ correlationId: 'execution:previous', currentTurnOrMessageId: 'previous-turn' })
  expect(f.lane().leaseToken).toBeUndefined()
})
