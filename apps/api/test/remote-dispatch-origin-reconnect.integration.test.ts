import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { freezePlacement, deriveDispatch } from '../src/modules/placement/binding.js'
import { reserveRemoteDispatchOrigin } from '../src/modules/placement/remoteReceiptCommit.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

function dispatch(run: { id: string }) {
  const mainId = randomUUID()
  const digest = 'a'.repeat(64)
  const registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: run.id, nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, registration,
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: 'execution', operationId: 'operation', attemptId: 'attempt',
    technicalAttempt: 1, occurrenceId: null, occurrenceIndex: 0, inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  if (placement.hostRef.kind !== 'device') throw new Error('Expected device placement')
  const original = { mainId, deviceId: placement.hostRef.deviceId, ...registration, bootId: randomUUID(), connectionGeneration: 1 }
  return { placement, intent, original }
}

describe.skipIf(!postgresEnabled)('original dispatch delivery connection in PostgreSQL', () => {
  it('keeps the first delivery on replay and refuses a different Worker boot', async () => {
    const db = await agent3Database()
    let owner: RunOwnership | undefined
    try {
      const { run } = await seedAgent3(db.pool, db.directory)
      owner = await RunOwnership.acquire(db.pool, run.id, () => undefined)
      if (!owner) throw new Error('Expected Run ownership')
      const owned = owner
      const f = dispatch(run)
      const connection = owned.oneShotConnection()
      await connection.transaction(async sql => {
        // Keep production types and unique constraints; isolate this dispatch from native execution admission.
        for (const table of ['execution_dispatch_intents', 'run_node_placements', 'remote_dispatch_origins']) {
          await sql.query(`create temporary table ${table} (like ${db.schema}.${table} including all)`)
        }
        await sql.query(`insert into run_node_placements(run_id,node_id,binding_hash,record)
          values($1,$2,$3,$4::jsonb)`, [run.id, f.intent.nodeId, f.intent.bindingHash, JSON.stringify(f.placement)])
        await sql.query(`insert into execution_dispatch_intents(operation_id,execution_id,run_id,node_id,
          binding_hash,attempt_id,record,scheduler_owner_id,scheduler_owner_fence)
          values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [f.intent.operationId, f.intent.executionId,
          run.id, f.intent.nodeId, f.intent.bindingHash, f.intent.attemptId, JSON.stringify(f.intent),
          'owner', '1'])
      })
      const reserve = (incoming: typeof f.original) => connection.transaction(sql =>
        reserveRemoteDispatchOrigin(sql, owned, f.intent, incoming, { assertCurrent: async () => {} }))
      await reserve(f.original)
      await reserve({ ...f.original, connectionGeneration: 2 })
      await expect(reserve({ ...f.original, bootId: randomUUID(), connectionGeneration: 3 }))
        .rejects.toMatchObject({ code: 'REMOTE_ORIGINAL_OPERATION_REQUIRED' })
      await connection.transaction(async sql => {
        const rows = await sql.query('select connection from remote_dispatch_origins where operation_id=$1',
          [f.intent.operationId])
        expect(rows.rows).toEqual([{ connection: f.original }])
      })
    } finally {
      await owner?.release()
      await db.close()
    }
  }, 60_000)
})
