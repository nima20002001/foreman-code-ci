import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { insertAcceptedPlacements } from '../src/modules/placement/persistence.js'
import { freezePlacement } from '../src/modules/placement/binding.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const digest = 'a'.repeat(64)
const placement = () => freezePlacement({ schemaVersion: 1, mainId, runId: 'run-1', nodeId: 'node-1',
  hostRef: { kind: 'main', mainId }, registration: null, mainInstallationId: 'original-main-1',
  destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest,
    rootPolicyId: 'policy-1', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation-1', attestationHash: digest },
  source: { revisionId: 'source-1', manifestDigest: digest, materializationId: 'materialization-1', materializationDigest: digest },
  payload: { kind: 'agent', agentId: 'agent-1', agentConfigurationVersionId: 'config-1', driverId: 'codex', driverRevision: '1',
    instanceId: 'instance-1', instanceRevision: '1', harnessInstallationId: 'install-1', installationFingerprint: digest,
    runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
/** Exercise the real transaction facade/finalizer ordering. SQL constraints and
 * process crash/lost-COMMIT evidence remain orchestrator integration gates. */
function database() {
  let committed: unknown[] = [], staged: unknown[] = []
  const events: string[] = []
  const raw = { query: async (text: string, values: unknown[] = []) => {
    events.push(text.split(' ')[0]!)
    if (text.startsWith('begin')) staged = [...committed]
    if (text === 'commit') committed = [...staged]
    if (text === 'rollback') staged = [...committed]
    if (text.startsWith('insert into run_node_placements')) {
      const records = Array.isArray(values[3]) ? values[3] as string[] : [values[3] as string]
      staged.push(...records.map(record => JSON.parse(record)))
    }
    if (text.startsWith('select record from run_node_placements')) return { rows: staged.map((record) => ({ record })), rowCount: staged.length }
    return { rows: [], rowCount: 0 }
  } } as unknown as pg.ClientBase
  return { connection: new ExclusiveGraphConnection(raw, () => undefined), events, committed: () => committed }
}
describe('same-transaction accepted placement evidence', () => {
  it('persists only after final readback and revision fence pass', async () => {
    const db = database(), pin = placement()
    let fences = 0
    await db.connection.transaction((sql) => insertAcceptedPlacements(sql, 'run-1', [{ id: 'node-1', agentId: 'agent-1' }],
      { 'agent-1': 'config-1' }, [pin], { assertCurrent: async () => { fences++ } }))
    expect(fences).toBe(2)
    expect(db.committed()).toEqual([pin])
    expect(db.events.at(-1)).toBe('commit')
    await db.connection.close()
  })
  it('rolls back staged evidence when live revision changes before COMMIT', async () => {
    const db = database()
    let fences = 0
    await expect(db.connection.transaction((sql) => insertAcceptedPlacements(sql, 'run-1', [{ id: 'node-1', agentId: 'agent-1' }],
      { 'agent-1': 'config-1' }, [placement()], { assertCurrent: async () => { if (++fences === 2) throw new Error('revoked before commit') } }))).rejects.toThrow('revoked')
    expect(db.committed()).toEqual([])
    expect(db.events.at(-1)).toBe('rollback')
    await db.connection.close()
  })
  it('rejects omitted or wrong configuration nodes before insert', async () => {
    const db = database()
    await expect(db.connection.transaction((sql) => insertAcceptedPlacements(sql, 'run-1', [{ id: 'node-1', agentId: 'agent-1' }],
      { 'agent-1': 'changed' }, [placement()], { assertCurrent: async () => undefined }))).rejects.toThrow('conflicts')
    expect(db.committed()).toEqual([])
    expect(db.events).not.toContain('insert')
    await db.connection.close()
  })
})
