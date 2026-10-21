import { describe, expect, it } from 'vitest'
import type { ExecutionResult } from '@foreman-code/contracts'
import { deliverableFailure, deliverableRepairPrompt, deliverableVerdict, nativeOutputSchema, type DeliverableContract } from './deliverable.js'

const known = new Set(['ticket-created-here'])
const contract = (over: Partial<DeliverableContract> = {}): DeliverableContract => ({
  source: 'text', referencesExist: async (_kind, values) =>
    values === undefined ? known : new Set(values.filter(value => known.has(value))), ...over,
})
const finalText = (text: string): ExecutionResult => ({ outcome: 'succeeded', output: { text } })
const schema = {
  type: 'object', required: ['status', 'summary'],
  properties: { status: { type: 'string', minLength: 1 }, summary: { type: 'string', minLength: 1 },
    ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' } },
}

describe('deliverable verdict', () => {
  it.each([{ $ref: '#/missing' }, { type: 'string', pattern: '[' }])(
    'classifies a runtime schema error as non-retryable configuration: %j', async outputSchema => {
      await expect(deliverableVerdict(finalText('"answer"'), contract({ outputSchema })))
        .rejects.toMatchObject({ result: { outcome: 'failed',
          error: { code: 'OUTPUT_SCHEMA_INVALID', retryable: false } } })
    },
  )
  it('passes a non-blank plain answer and rejects a blank one under the default rule', async () => {
    expect(await deliverableVerdict(finalText('Reviewed the diff.'), contract())).toBeUndefined()
    expect(await deliverableVerdict(finalText('  '), contract())).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
  })

  it('does not judge a failed result', async () => {
    expect(await deliverableVerdict({ outcome: 'failed', error: { code: 'X', message: 'x', retryable: false } }, contract())).toBeUndefined()
  })

  it('requires a declared schema to hold for JSON text and reports the exact paths', async () => {
    const verdict = await deliverableVerdict(finalText('{"status":"done"}'), contract({ outputSchema: schema }))
    expect(verdict?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    expect(verdict?.issues.map(issue => issue.path)).toContain('/summary')
    expect(await deliverableVerdict(finalText('```json\n{}\n```'), contract({ outputSchema: schema }))).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
    expect(await deliverableVerdict(finalText('{"status":"done","summary":"Shipped."}'), contract({ outputSchema: schema }))).toBeUndefined()
  })

  it('verifies references only after the shape passes, reporting OUTPUT_REFERENCE_UNKNOWN', async () => {
    const answer = (ticket: string) => finalText(JSON.stringify({ status: 'done', summary: 'ok', ticket }))
    expect(await deliverableVerdict(answer('ticket-created-here'), contract({ outputSchema: schema }))).toBeUndefined()
    expect(await deliverableVerdict(answer('someone-else'), contract({ outputSchema: schema })))
      .toMatchObject({ code: 'OUTPUT_REFERENCE_UNKNOWN', issues: [{ code: 'OUTPUT_REFERENCE_UNKNOWN', path: '/ticket' }] })
  })

  it('reads latestDeliverable from the native text envelope and leaves a malformed envelope to routing validation', async () => {
    const envelope = (latestDeliverable: unknown) => finalText(JSON.stringify({ routing: { kind: 'finish' }, data: { latestDeliverable, remainingFindings: [] } }))
    const source = { source: 'latestDeliverable' as const }
    expect(await deliverableVerdict(envelope({ status: 'done', summary: 'ok' }), contract({ ...source, outputSchema: schema }))).toBeUndefined()
    expect(await deliverableVerdict(envelope({}), contract(source))).toBeUndefined()
    expect(await deliverableVerdict(envelope(null), contract(source))).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
    expect(await deliverableVerdict(finalText('not an envelope'), contract({ ...source, outputSchema: schema }))).toBeUndefined()
  })

  it('checks choice data only against a declared schema, since the choice contract allows null data', async () => {
    const choice = (data: unknown) => finalText(JSON.stringify({ routing: { outcome: 'approve' }, data }))
    expect(await deliverableVerdict(choice(null), contract({ source: 'data' }))).toBeUndefined()
    expect(await deliverableVerdict(choice(null), contract({ source: 'data', outputSchema: schema }))).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
    expect(await deliverableVerdict(choice({ status: 'done', summary: 'ok' }), contract({ source: 'data', outputSchema: schema }))).toBeUndefined()
  })
})

describe('deliverable repair and failure', () => {
  it('lists capped execution references with the closest ticket first without accepting a mistyped ID', async () => {
    const correct = '3a8c3e61-9ffc-4054-9f4e-ce7d71ff6898'
    const mistyped = '3a8c3e61-9ffc-4054-9f4e-ce7d71f68698'
    const tickets = Array.from({ length: 66 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    const valid = new Set([...tickets, correct])
    const outputSchema = {
      type: 'object', properties: {
        tickets: { type: 'array', items: {
          type: 'object', properties: { ticketId: { type: 'string', 'x-foreman-reference': 'ciTicket' } },
        } },
      },
    }
    const answer = finalText(JSON.stringify({
      tickets: [...tickets.slice(0, 10), mistyped].map(ticketId => ({ ticketId })),
    }))
    const original = structuredClone(answer)
    const deliverableContract = contract({
      outputSchema,
      referencesExist: async (_kind, values) => values === undefined
        ? valid : new Set(values.filter(value => valid.has(value))),
    })

    const verdict = await deliverableVerdict(answer, deliverableContract)
    expect(verdict).toMatchObject({ code: 'OUTPUT_REFERENCE_UNKNOWN', issues: [{ path: '/tickets/10/ticketId' }] })
    const prompt = deliverableRepairPrompt(verdict!, outputSchema)
    const listed = /Valid ciTicket IDs \(closest match first\): (\[.*?\])/.exec(prompt)
    expect(listed).not.toBeNull()
    const ids = JSON.parse(listed![1]!) as string[]
    expect(ids).toHaveLength(50)
    expect(ids[0]).toBe(correct)
    expect(ids.every(id => valid.has(id))).toBe(true)
    expect(prompt).toContain(JSON.stringify(ids))
    expect(prompt).toContain('17 more omitted')
    expect(prompt).toContain(mistyped)
    expect(answer).toEqual(original)
    expect(await deliverableVerdict(answer, deliverableContract)).toMatchObject({ code: 'OUTPUT_REFERENCE_UNKNOWN' })
    const corrected = finalText(JSON.stringify({ tickets: [{ ticketId: correct }] }))
    expect(await deliverableVerdict(corrected, deliverableContract)).toBeUndefined()
  })

  it.each([{ ids: [] }, { ids: ['only-ticket'] }])('lists all available references when there are few: $ids', async ({ ids }) => {
    const verdict = await deliverableVerdict(finalText(JSON.stringify({
      status: 'done', summary: 'ok', ticket: 'unknown-ticket',
    })), contract({ outputSchema: schema, referencesExist: async () => new Set(ids) }))
    expect(deliverableRepairPrompt(verdict!, schema))
      .toContain(`Valid ciTicket IDs (closest match first): ${JSON.stringify(ids)}`)
  })

  it('lists every validation issue exactly in the corrective turn', async () => {
    const verdict = await deliverableVerdict(finalText('{}'), contract({ outputSchema: schema }))
    const prompt = deliverableRepairPrompt(verdict!, schema)
    expect(prompt).toContain(JSON.stringify(verdict!.issues))
    expect(prompt).toContain('same execution')
  })

  it('fails loudly with a non-retryable result carrying the code and every issue', async () => {
    const verdict = await deliverableVerdict(finalText('{}'), contract({ outputSchema: schema }))
    expect(deliverableFailure(verdict!)).toMatchObject({ outcome: 'failed', error: { code: 'OUTPUT_SCHEMA_MISMATCH', retryable: false } })
  })

  it('sends Codex native structured output only for strict plain-answer schemas, without reference markers', () => {
    const strict = { type: 'object', additionalProperties: false, required: ['status', 'ticket'],
      properties: { status: { type: 'string' }, ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' } } }
    expect(nativeOutputSchema(contract({ outputSchema: strict }))).toEqual({ type: 'object', additionalProperties: false,
      required: ['status', 'ticket'], properties: { status: { type: 'string' }, ticket: { type: 'string' } } })
    expect(nativeOutputSchema(contract({ outputSchema: schema }))).toBeUndefined()
    expect(nativeOutputSchema(contract({ source: 'data', outputSchema: strict }))).toBeUndefined()
    expect(nativeOutputSchema(contract())).toBeUndefined()
  })
})
