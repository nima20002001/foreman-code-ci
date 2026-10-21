import { beforeEach, expect, it, vi } from 'vitest'
import type { TransferContext } from '@foreman-code/contracts/byte-transfer'
import type { WorkflowNativeCapture } from '../../interactions/workflowNativeCapture.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import type { RepeatNativeEvidence } from '../repeatNativeRepository.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
const calls = vi.hoisted(() => ({ admit: vi.fn(), construct: vi.fn() }))
vi.mock('./workflowNativeFileContext.js', () => ({ WorkflowNativeFileContextAdmission: class {
  constructor(...args: unknown[]) { calls.construct(...args) }
  resolveOrAdmitLocked = calls.admit
} }))
import { createProductionWorkflowFileContexts } from './workflowNativeFilesProduction.js'
beforeEach(() => vi.clearAllMocks())
function fixture() {
  // Common wiring only; the producer's separate suite checks original private
  // captures and SQL authority. These unit ports cannot authorize production.
  const capture = { session: { harness: 'codex' }, execution: { state: 'running' },
    lane: { providerId: 'original-turn' }, source: { type: 'event', event: { type: 'turn.started' } } } as { -readonly [K in keyof WorkflowNativeCapture]: WorkflowNativeCapture[K] }
  const transfer = { connectionEpoch: 'original-opaque-epoch' } as TransferContext
  const ports = { captures: { read: vi.fn(() => capture) }, assertPhysical: vi.fn(),
    authority: { authorize: vi.fn() }, transferContext: vi.fn(() => transfer as TransferContext | undefined) }
  const callback = createProductionWorkflowFileContexts('original-main', ports)
  const sql = {} as GraphTransactionSql, evidence = {} as RepeatNativeEvidence, proof = {} as WorkflowNativeProofRecord
  return { capture, ports, transfer, callback, sql, evidence, proof }
}
it('passes the exact stored proof, open transaction and original transfer to admission', async () => {
  const f = fixture()
  await f.callback(f.sql, f.evidence, f.proof)
  expect(calls.construct).toHaveBeenCalledExactlyOnceWith('original-main', f.ports)
  expect(f.ports.transferContext).toHaveBeenCalledExactlyOnceWith(f.capture)
  expect(calls.admit).toHaveBeenCalledExactlyOnceWith(f.sql, f.evidence, f.proof, f.transfer)
})
it.each(['boundary', 'session_created', 'terminal-history', 'no-turn', 'closed', 'claude', 'later-event'])('does not admit unsupported %s observations', async kind => {
  const f = fixture()
  if (kind === 'boundary' || kind === 'session_created') f.capture.source = { type: kind } as WorkflowNativeCapture['source']
  if (kind === 'terminal-history') f.capture.source = { type: 'history', history: { terminalTurn: {} } } as WorkflowNativeCapture['source']
  if (kind === 'no-turn') f.capture.lane = null
  if (kind === 'closed') f.capture.execution.state = 'completed'
  if (kind === 'claude') f.capture.session.harness = 'claude'
  if (kind === 'later-event') f.capture.source = { type: 'event', event: { type: 'item.completed' } } as WorkflowNativeCapture['source']
  await f.callback(f.sql, f.evidence, f.proof)
  expect(f.ports.transferContext).not.toHaveBeenCalled()
  expect(calls.admit).not.toHaveBeenCalled()
})
it('can recover a lost first turn-start event through genuine nonterminal original history', async () => {
  const f = fixture()
  f.capture.source = { type: 'history', history: { nativeTurnId: 'original-turn' } } as WorkflowNativeCapture['source']
  await f.callback(f.sql, f.evidence, f.proof)
  expect(calls.admit).toHaveBeenCalledExactlyOnceWith(f.sql, f.evidence, f.proof, f.transfer)
})
it('leaves local sessions without a distributed context', async () => {
  const f = fixture(); f.ports.transferContext.mockReturnValue(undefined)
  await f.callback(f.sql, f.evidence, f.proof)
  expect(calls.admit).not.toHaveBeenCalled()
})
it('propagates original physical loss and admission failure to the proof transaction', async () => {
  const f = fixture(); f.ports.transferContext.mockImplementation(() => { throw new Error('physical lost') })
  await expect(f.callback(f.sql, f.evidence, f.proof)).rejects.toThrow('physical lost')
  expect(calls.admit).not.toHaveBeenCalled()
  f.ports.transferContext.mockReturnValue(f.transfer); calls.admit.mockRejectedValueOnce(new Error('authority lost'))
  await expect(f.callback(f.sql, f.evidence, f.proof)).rejects.toThrow('authority lost')
})
