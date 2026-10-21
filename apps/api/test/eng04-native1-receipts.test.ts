import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { beforeGraphCommit, ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit,
  type RepeatCanonicalReceipt } from '../src/modules/run-graph/repeatReceipts.js'
import { nativeFixture } from './eng04-native-fixtures.js'

const digest = `sha256:${'a'.repeat(64)}`
const semantic = `sha256:${'b'.repeat(64)}`
function fixture() {
  const scope = nativeFixture().scope
  const receipt: RepeatCanonicalReceipt = { scope, evidence: { sourceKind: 'execution', sourceId: 'repeat-source', sourceRevision: '1' },
    sourceDigest: digest, semanticDigest: semantic, effect: { kind: 'execution.launch', entityId: 'execution', digest } }
  const row = { workspace_id: scope.workspaceId, workflow_id: scope.workflowId, workflow_version_id: scope.workflowVersionId,
    execution_semantics_version: 3, protocol_version: 1, head_sequence: '19', source_digest: digest,
    source_semantic_digest: semantic, source_sequence: '12', effect_digest: digest,
    effect_semantic_digest: semantic, effect_sequence: '12' }
  const calls: string[] = []
  const reads: unknown[][] = []
  const rows: Array<Record<string, unknown>> = [row]
  const client = { async query(text: string, values: unknown[] = []) {
    const q = text.replace(/\s+/g, ' ').trim()
    calls.push(q.startsWith('select') ? 'receipt-read' : q)
    if (q.startsWith('select')) {
      reads.push(structuredClone(values))
      return { rows: structuredClone(rows), rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  } } as unknown as pg.ClientBase
  return { receipt, row, rows, calls, reads, connection: new ExclusiveGraphConnection(client, () => undefined) }
}

/** Real transaction facade and receipt code over scripted query replies. These
 * are NOT PostgreSQL, HTTP/MCP authentication, native or snapshot parity tests. */
describe('ENG04 NATIVE-1 canonical same-transaction receipt readback', () => {
  it('reads both permanent receipts in the owning transaction before commit', async () => {
    const f = fixture()
    await f.connection.transaction((sql) => assertRepeatCanonicalReceiptLocked(sql, f.receipt))
    expect(f.calls[0]).toMatch(/^begin/)
    expect(f.calls.at(-1)).toBe('commit')
    expect(f.reads).toEqual([[f.receipt.scope.runId, f.receipt.evidence.sourceKind,
      f.receipt.evidence.sourceId, f.receipt.evidence.sourceRevision,
      f.receipt.effect!.kind, f.receipt.effect!.entityId]])
    await f.connection.close()
  })
  it('enlists readback after the canonical publication finalizer, not a detached read', async () => {
    const f = fixture()
    f.rows.length = 0
    await f.connection.transaction(async (sql) => {
      beforeGraphCommit(sql, async () => {
        f.calls.push('canonical-finalizer')
        f.rows.push(f.row)
      })
      requireRepeatCanonicalReceiptBeforeCommit(sql, f.receipt)
      expect(f.calls).toHaveLength(1)
    })
    expect(f.calls[1]).toBe('canonical-finalizer')
    expect(f.calls[2]).toBe('receipt-read')
    expect(f.calls.at(-1)).toBe('commit')
    await f.connection.close()
  })
  it('rolls back when the canonical producer forgot its receipt finalizer', async () => {
    const f = fixture(); f.rows.length = 0
    await expect(f.connection.transaction(async (sql) => {
      requireRepeatCanonicalReceiptBeforeCommit(sql, f.receipt)
    })).rejects.toMatchObject({ code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
    expect(f.calls.at(-1)).toBe('rollback')
    expect(f.calls).not.toContain('commit')
    await f.connection.close()
  })
  it('a caught receipt failure still poisons the transaction', async () => {
    const f = fixture(); f.rows.length = 0
    await expect(f.connection.transaction(async (sql) => {
      await assertRepeatCanonicalReceiptLocked(sql, f.receipt).catch(() => undefined)
    })).rejects.toMatchObject({ code: 'GRAPH_TRANSACTION_FAILED' })
    expect(f.calls).not.toContain('commit')
    await f.connection.close()
  })
  it('does not require a retained batch after reset/retention removed the payload', async () => {
    const f = fixture()
    // Only permanent source/effect receipts are returned by this fixture; there
    // is intentionally no batch row. This is not a reducer/snapshot parity claim.
    await f.connection.transaction((sql) => assertRepeatCanonicalReceiptLocked(sql, f.receipt))
    expect(f.calls.at(-1)).toBe('commit')
    await f.connection.close()
  })
  it('snapshots proof identity when enlisting a commit check', async () => {
    const f = fixture()
    await f.connection.transaction(async (sql) => {
      requireRepeatCanonicalReceiptBeforeCommit(sql, f.receipt)
      f.receipt.scope.workflowId = 'changed-later'
      f.receipt.sourceDigest = `sha256:${'c'.repeat(64)}`
      f.receipt.effect!.entityId = 'changed-later'
    })
    expect(f.calls.at(-1)).toBe('commit')
    await f.connection.close()
  })
  for (const [key, value] of [
    ['workspace_id', 'crossed'], ['workflow_id', 'crossed'], ['workflow_version_id', 'crossed'],
    ['execution_semantics_version', 2], ['protocol_version', 2], ['source_digest', semantic],
    ['source_semantic_digest', digest], ['head_sequence', '11'], ['source_sequence', '0'],
    ['effect_digest', null], ['effect_semantic_digest', digest], ['effect_sequence', '13'],
  ] as const) it(`rejects a crossed or missing receipt field: ${key}`, async () => {
    const f = fixture(); f.rows[0]![key] = value
    await expect(f.connection.transaction((sql) => assertRepeatCanonicalReceiptLocked(sql, f.receipt)))
      .rejects.toMatchObject({ code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
    expect(f.calls).not.toContain('commit')
    await f.connection.close()
  })
})
