import { describe, expect, it } from 'vitest'
import { saveNativeProtocolFixture as protocolFixture } from './helpers/eng07SaveNativeSettlement.testSupport.js'
import { recoveryIdentity } from './helpers/eng06Recovery.testSupport.js'

describe('ENG07 read-only Save native proof facet (real canonical readers, SQL protocol fake)', () => {
  it.each(['closed', 'recovered', 'unbound-disposal', 'unbound-recovery', 'not-submitted'] as const)('accepts %s without native work, writes or transaction capabilities', async (proof) => {
    const t = protocolFixture(proof)
    try {
      expect(await t.check()).toBe(true)
      expect(t.db.state.inserts).toBe(0); expect(t.db.state.commits).toBe(0); expect(t.db.state.rollbacks).toBe(0)
      expect(t.statements.length).toBeGreaterThan(1)
    } finally { await t.close() }
  })

  it.each(['reserved', 'prepared', 'entered'])('%s plus no session/process receipt is not proof of non-submission', async (phase) => {
    const t = protocolFixture('none')
    t.entry.phase = phase
    try { expect(await t.check()).toBe(false) } finally { await t.close() }
  })

  it.each(['entry', 'receipt', 'scope', 'attempt', 'input', 'source-digest', 'source-sequence', 'occurrence'] as const)('rejects a sealed attempt with missing/mismatched %s evidence', async (fault) => {
    const t = protocolFixture('not-submitted')
    switch (fault) {
      case 'entry': t.state.entry = false; break
      case 'receipt': t.state.receipt = false; break
      case 'scope': t.receipt.workflow_version_id = 'wrong-version'; break
      case 'attempt': t.entry.reservation.execution.attempt++; break
      case 'input': t.entry.reservation.inputDigest = `sha256:${'f'.repeat(64)}`; break
      case 'source-digest': t.receipt.source_digest = `sha256:${'f'.repeat(64)}`; break
      case 'source-sequence': t.receipt.source_sequence = '4'; break
      case 'occurrence': t.state.occurrenceId = 'invented-occurrence'; break
    }
    try { expect(await t.check()).toBe(false) } finally { await t.close() }
  })

  it.each(['missing', 'identity', 'session', 'generation', 'prior-unclosed'] as const)('rejects %s recovered closure evidence', async (fault) => {
    const t = protocolFixture('recovered')
    switch (fault) {
      case 'missing': t.db.state.proof = undefined; break
      case 'identity': t.db.state.proof!.execution_identity = { ...recoveryIdentity(t.db.state.execution), attempt: 2 }; break
      case 'session': t.db.state.proof!.reference = { ...t.db.state.session, nativeSessionId: 'different-session' }; break
      case 'generation': t.db.state.proof!.generation = '70'; break
      case 'prior-unclosed': t.db.state.lifetime!.prior_unclosed = true; break
    }
    try { expect(await t.check()).toBe(false) } finally { await t.close() }
  })

  it('a launch reservation with no recovered unbound receipt stays blocked', async () => {
    const t = protocolFixture('unbound-recovery')
    t.db.state.proof = undefined
    try { expect(await t.check()).toBe(false) } finally { await t.close() }
  })

  it('a successful result cannot use unbound disposal as a substitute for its native session', async () => {
    const t = protocolFixture('unbound-disposal')
    t.db.state.execution.result = { outcome: 'succeeded', output: { original: true } }
    try { expect(await t.check()).toBe(false) } finally { await t.close() }
  })

  it('an ordinary close must match its expected session and the latest generation', async () => {
    const t = protocolFixture('closed')
    t.db.state.lifetime!.expected_reference = { ...t.db.state.session, nativeSessionId: 'wrong' }
    try { expect(await t.check()).toBe(false) } finally { await t.close() }
  })
})
