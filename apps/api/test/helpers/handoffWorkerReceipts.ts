import { randomUUID } from 'node:crypto'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import type { NativeHarnessSessionManager } from '../../src/modules/harnesses/port.js'
import { readAcceptedPlacement, readDispatchIntent } from '../../src/modules/placement/persistence.js'

type Query = Parameters<typeof readDispatchIntent>[0]

/** A real Worker retains its own terminal receipt when it settles the original turn;
 * Main refuses to settle a device-placed result that the Worker never attested. The
 * synthetic provider has no Worker, so settling a device-placed turn records the
 * receipt the Worker would have retained for exactly that provider terminal. */
export function settlesWorkerTerminals(pool: Query, manager: NativeHarnessSessionManager): NativeHarnessSessionManager {
  return { ...manager, async settleTurn(session, correlationId, signal) {
    const history = await manager.reconcile!(session, correlationId, signal)
    const terminal = history.terminalTurn
    const intent = terminal && await readDispatchIntent(pool, correlationId.replace(/^execution:/, ''))
    const placement = intent && await readAcceptedPlacement(pool, intent.runId, intent.nodeId)
    if (!terminal || !intent || placement?.hostRef.kind !== 'device') return history
    const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent,
      connection: { mainId: intent.mainId, deviceId: placement.hostRef.deviceId, workerInstallationId: randomUUID(),
        bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
      workerIncarnationId: randomUUID(), sequence: 1, phase: 'confirmed_terminal',
      native: { sessionId: session.nativeSessionId, turnId: terminal.providerId, processIdentityDigest: 'a'.repeat(64) },
      terminal: { kind: 'completed', closureEvidenceDigest: 'b'.repeat(64), result: terminal.result },
      entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [],
      turnInput: { correlationId, promptDigest: 'c'.repeat(64), sessionMode: 'regular' } })
    await pool.query(`insert into remote_execution_receipts(operation_id,sequence,receipt) values($1,$2,$3::jsonb)
      on conflict(operation_id) do nothing`, [intent.operationId, receipt.sequence, JSON.stringify(receipt)])
    return history
  } }
}
