import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { assertGraphTransaction } from '../src/modules/run-graph/connection.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { readRecordedExecutionResultLocked, readRepeatAcceptedResultLocked } from '../src/modules/runs/repeatPostgres.js'
import { repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'
import { currentExecutionReadUnit } from './helpers/currentExecutionReadUnit.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'
import {
  br2001Fixture, br2001InvalidTexts, br2001Providers, br2001Terminal, br2001Text,
  type Br2001Provider,
} from './helpers/wave25Br2001Choice.js'

/** The removed putNodeResolution/oneShotResolution seam is now the current
 * accepted-result readback: it independently re-parses the raw carrier, compares
 * its saved resolution and input identity, and requires canonical receipts.
 * SQL data is synthetic; the real V3 reader/parser/transaction guards execute.
 * Acceptance writes are covered separately by eng04-a-repeat-core.test.ts. */
function fixture(provider: Br2001Provider, suffix: string, ordinary = false) {
  const choice = br2001Fixture(provider, suffix)
  if (ordinary) delete choice.version.definition.nodes[0]!.choice
  const f = currentUnitSnapshot(suffix, 'sequential')
  return currentExecutionReadUnit({ ...f, version: choice.version, configurations: choice.configurations })
}
type Fixture = ReturnType<typeof fixture>
function claimedResolution(f: Fixture, execution: HarnessExecution, outcome = 'pass') {
  // An untrusted persisted claim is constructed independently of the stored raw
  // carrier. Merely giving it the correct raw digest must not make it acceptable.
  const valid = HarnessExecutionSchema.parse({ ...execution, result: {
    outcome: 'succeeded', output: { routing: { outcome }, data: null },
  } })
  const resolution = repeatTerminalResolution(f.f.version, f.f.scope, f.ref, valid)
  return { ...resolution, value: { ...resolution.value, acceptedResultDigest: graphSourceDigest(execution.result) } }
}
async function rejectsRead(f: Fixture) {
  f.calls.length = 0
  await expect(f.read()).rejects.toBeInstanceOf(Error)
  expect(f.calls.some(({ q }) => q === 'rollback')).toBe(true)
  expect(f.calls.some(({ q }) => q === 'commit')).toBe(false)
  expect(f.calls.some(({ q }) => /^(insert|update|delete)\b/i.test(q))).toBe(false)
}

describe.each(br2001Providers)('%s stored choice result validation', (provider) => {
  it('reads historical results while retaining digest and canonical receipt checks', async () => {
    const f = fixture(provider, `historical-result-${provider}`)
    try {
      const terminal = br2001Terminal(f.state.execution, provider, br2001Text('pass'))
      const resolution = claimedResolution(f, terminal.execution)
      const historical = { ...resolution, value: { ...resolution.value, branchEnded: false } }
      f.seedAccepted(terminal.execution, historical)
      const read = () => f.transaction(sql => readRecordedExecutionResultLocked(sql, f.snapshot(), f.candidate.id))
      expect(await read()).toEqual(terminal.result)
      expect(f.state.resolution).toEqual(historical)
      await expect(f.read()).rejects.toMatchObject({ code: 'REPEAT_INPUT_NOT_ACCEPTED' })
      f.state.result!.result_digest = '0'.repeat(64)
      await expect(read()).rejects.toMatchObject({ code: 'REPEAT_INPUT_NOT_ACCEPTED' })
      f.seedAccepted(terminal.execution, historical)
      f.state.receipts = f.state.receipts.filter(row => row.evidence.sourceKind !== 'node_resolution')
      await expect(read()).rejects.toMatchObject({ code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
    } finally {
      await f.connection.close()
    }
  })

  it.each(['pass', 'issues'])('reads %s from the exact accepted raw carrier without rewriting it', async (outcome) => {
    const f = fixture(provider, `br2001-record-${provider}`)
    try {
      const terminal = br2001Terminal(f.state.execution, provider, br2001Text(outcome, { provider }))
      const before = structuredClone(terminal.execution), resolution = claimedResolution(f, terminal.execution, outcome)
      f.seedAccepted(terminal.execution, resolution)
      expect(await f.read()).toEqual(terminal.result)
      expect(f.state.execution).toEqual(before)
      expect(f.state.resolution).toEqual(resolution)
      expect(resolution.value.acceptedResultDigest).toBe(graphSourceDigest(terminal.result))
      expect(resolution.value.selectedRelationshipIds).toEqual(outcome === 'issues' ? [f.f.version.definition.edges[0]!.id] : [])
      expect(resolution.value.branchEnded).toBe(outcome === 'pass')
      expect(f.calls.some(({ q }) => q === 'commit')).toBe(true)
      expect(f.calls.some(({ q }) => /^(insert|update|delete)\b/i.test(q))).toBe(false)
    } finally { await f.connection.close() }
  })

  it.each(br2001InvalidTexts)('independently rejects stored $name despite a matching raw digest', async ({ text }) => {
    const f = fixture(provider, `br2001-record-invalid-${provider}`)
    try {
      const execution = br2001Terminal(f.state.execution, provider, text).execution
      f.seedAccepted(execution, claimedResolution(f, execution))
      await rejectsRead(f)
    } finally { await f.connection.close() }
  })

  it('does not accept mixed, nested, non-string or array carriers', async () => {
    const f = fixture(provider, `br2001-record-mixed-${provider}`)
    try {
      const text = br2001Text(), base = br2001Terminal(f.state.execution, provider, text).execution
      for (const output of [{ text, extra: true }, { text, routing: { outcome: 'issues' }, data: null },
        { text: JSON.parse(text) }, { text: null }, { text: 0 }, { output: { text } }, [{ text }]]) {
        const execution = HarnessExecutionSchema.parse({ ...base, result: { outcome: 'succeeded', output } })
        f.seedAccepted(execution, claimedResolution(f, execution))
        await rejectsRead(f)
      }
    } finally { await f.connection.close() }
  })

  it('preserves complete raw-result byte limits at the independent durable boundary', async () => {
    const f = fixture(provider, `br2001-record-bound-${provider}`)
    try {
      const empty = br2001Terminal(f.state.execution, provider, br2001Text('pass', ''))
      const overhead = Buffer.byteLength(canonicalGraphJson(empty.result), 'utf8')
      const data = 'x'.repeat(64 * 1024 - overhead)
      const atLimit = br2001Terminal(f.state.execution, provider, br2001Text('pass', data)).execution
      f.seedAccepted(atLimit, claimedResolution(f, atLimit))
      expect(Buffer.byteLength(f.state.result!.result_json, 'utf8')).toBe(64 * 1024)
      expect(await f.read()).toEqual(atLimit.result)
      const overLimit = br2001Terminal(f.state.execution, provider, br2001Text('pass', data + 'x')).execution
      f.seedAccepted(overLimit, claimedResolution(f, overLimit))
      await rejectsRead(f)
    } finally { await f.connection.close() }
  })

  it('rolls back a failed choice read even when its caller catches the rejection', async () => {
    const f = fixture(provider, `br2001-record-poison-${provider}`)
    try {
      const execution = br2001Terminal(f.state.execution, provider, 'not JSON').execution
      f.seedAccepted(execution, claimedResolution(f, execution))
      await rejectsRead(f)
      expect(f.state.execution.result).toEqual(execution.result)
      expect(f.state.accepted).toBe(true) // A read must not "repair" corrupted historical data.
    } finally { await f.connection.close() }
  })

  it('cannot commit after a caller swallows a missing canonical receipt error', async () => {
    const f = fixture(provider, `br2001-record-receipt-${provider}`)
    try {
      const execution = br2001Terminal(f.state.execution, provider, br2001Text()).execution
      f.seedAccepted(execution)
      f.state.receipts = f.state.receipts.filter((row) => row.effect?.kind !== 'input.bind')
      await expect(f.transaction(async (sql) => {
        await expect(readRepeatAcceptedResultLocked(sql, f.snapshot(), f.candidate.id))
          .rejects.toMatchObject({ code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
        expect(() => assertGraphTransaction(sql)).toThrow('GRAPH_TRANSACTION_FAILED')
      })).rejects.toMatchObject({ code: 'GRAPH_TRANSACTION_FAILED' })
      expect(f.calls.some(({ q }) => q === 'commit')).toBe(false)
      expect(f.calls.some(({ q }) => q === 'rollback')).toBe(true)
    } finally { await f.connection.close() }
  })

  it('retains acceptance, raw digest, identity, immutable pin and declared-route checks', async () => {
    const f = fixture(provider, `br2001-record-fences-${provider}`)
    try {
      const terminal = br2001Terminal(f.state.execution, provider, br2001Text('issues'))
      const execution = terminal.execution, resolution = claimedResolution(f, execution, 'issues')
      f.seedAccepted(execution, resolution)
      f.state.accepted = false
      expect(await f.read()).toBeUndefined()
      expect(f.calls.some(({ q }) => q.includes('result_json,result_digest from run_repeat_results'))).toBe(false)
      for (const proposed of [
        { ...resolution.value, acceptedResultDigest: graphSourceDigest({ outcome: 'succeeded', output: terminal.result.output.text }) },
        { ...resolution.value, outcome: 'pass', branchEnded: true, selectedRelationshipIds: [], unselectedRelationshipIds: [f.f.version.definition.edges[0]!.id] },
        { ...resolution.value, execution: { ...resolution.value.execution!, executionId: 'different-execution' } },
        { ...resolution.value, selectedRelationshipIds: ['different-edge'], unselectedRelationshipIds: [] },
      ]) {
        f.seedAccepted(execution, { ...resolution, value: proposed })
        await rejectsRead(f)
      }
      for (const record of [{ ...execution, runId: 'different-run' },
        { ...execution, agentConfigurationVersionId: 'different-pin' }, { ...execution, attempt: 2 },
        { ...execution, state: 'running', result: undefined, finishedAt: undefined }]) {
        f.seedAccepted(execution, resolution)
        f.state.execution = HarnessExecutionSchema.parse(record)
        await rejectsRead(f)
      }
    } finally { await f.connection.close() }
  })

  it('preserves direct string/object choice results and ordinary non-choice results', async () => {
    for (const ordinary of [false, true]) {
      const f = fixture(provider, `br2001-record-compatible-${provider}`, ordinary)
      try {
        const base = br2001Terminal(f.state.execution, provider, br2001Text()).execution
        const values = ordinary ? [{ text: 'ordinary reply' }, 'plain text', { done: true }]
          : [br2001Text(), JSON.parse(br2001Text()), { text: ` \n${br2001Text()}\t ` }]
        for (const output of values) {
          const execution = HarnessExecutionSchema.parse({ ...base, result: { outcome: 'succeeded', output } })
          const resolution = repeatTerminalResolution(f.f.version, f.f.scope, f.ref, execution)
          f.seedAccepted(execution, resolution)
          expect(await f.read()).toEqual(execution.result)
          expect(f.state.execution).toEqual(execution)
          if (ordinary) {
            expect(resolution.value.outcome).toBeUndefined()
            expect(resolution.value.selectedRelationshipIds).toEqual([f.f.version.definition.edges[0]!.id])
          }
        }
      } finally { await f.connection.close() }
    }
  })
})
