import { describe, expect, it } from 'vitest'
import {
  OutputSchemaSchema, NodeSkillOverrideSchema, checkDeliverable, deliverableReferences, OUTPUT_SCHEMA_MAX_BYTES,
} from './outputContract.js'

const statusSummary = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
  },
}

describe('workflow Agent output schema', () => {
  it('accepts a JSON Schema with a ciTicket reference marker on a string property', () => {
    const schema = { type: 'object', properties: { ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' } } }
    expect(OutputSchemaSchema.parse(schema)).toEqual(schema)
  })

  it('rejects unknown reference kinds, markers on non-string values, remote refs and oversized schemas', () => {
    expect(OutputSchemaSchema.safeParse({ properties: { t: { type: 'string', 'x-foreman-reference': 'run' } } }).success).toBe(false)
    expect(OutputSchemaSchema.safeParse({ properties: { t: { type: 'number', 'x-foreman-reference': 'ciTicket' } } }).success).toBe(false)
    expect(OutputSchemaSchema.safeParse({ $ref: 'https://example.com/schema.json' }).success).toBe(false)
    const oversized = { type: 'string', description: 'x'.repeat(OUTPUT_SCHEMA_MAX_BYTES) }
    expect(OutputSchemaSchema.safeParse(oversized).success).toBe(false)
  })

  it.each(['$defs', 'definitions', 'patternProperties', 'dependentSchemas'])(
    'rejects reference markers hidden in %s', keyword => {
      const schema = { [keyword]: { ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' } } }
      expect(OutputSchemaSchema.safeParse(schema).success).toBe(false)
    },
  )

  it.each(['allOf', 'anyOf', 'oneOf', 'prefixItems'])(
    'rejects reference markers hidden in %s branches', keyword => {
      const schema = { [keyword]: [{ type: 'string', 'x-foreman-reference': 'ciTicket' }] }
      expect(OutputSchemaSchema.safeParse(schema).success).toBe(false)
    },
  )

  it.each(['not', 'if', 'then', 'else', 'contains', 'additionalProperties', 'unevaluatedItems'])(
    'rejects reference markers hidden in %s schemas', keyword => {
      const schema = { [keyword]: { type: 'string', 'x-foreman-reference': 'ciTicket' } }
      expect(OutputSchemaSchema.safeParse(schema).success).toBe(false)
    },
  )

  it('rejects refs that can reuse a marker outside its declared property', () => {
    const schema = { type: 'object', properties: {
      ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' },
      alias: { $ref: '#/properties/ticket' },
    } }
    expect(OutputSchemaSchema.safeParse(schema).success).toBe(false)
  })

  it.each([
    { $ref: '#/$defs/missing' },
    { type: 'string', pattern: '[' },
    { type: 'object', patternProperties: { '[': { type: 'string' } } },
    { type: 'invalid' },
    { required: 'ticket' },
    { properties: { ticket: 42 } },
    { allOf: { type: 'string' } },
    { minLength: -1 },
  ])('rejects invalid schema configuration at authoring: %j', schema => {
    expect(OutputSchemaSchema.safeParse(schema).success).toBe(false)
  })

  it('keeps local refs and composition available without reference markers', () => {
    const schema = { $defs: { ticket: { type: 'string', pattern: '^ticket-' } },
      allOf: [{ $ref: '#/$defs/ticket' }] }
    expect(OutputSchemaSchema.parse(schema)).toEqual(schema)
    expect(checkDeliverable('ticket-created', schema)).toEqual([])
    expect(checkDeliverable('unknown', schema)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'OUTPUT_SCHEMA_MISMATCH' })]),
    )
  })

  it('accepts exact added skill versions and removed skill IDs, and rejects a skill named in both lists', () => {
    const override = { add: [{ skillId: 'skill-a', version: '3' }], remove: ['skill-b'] }
    expect(NodeSkillOverrideSchema.parse(override)).toEqual(override)
    expect(NodeSkillOverrideSchema.safeParse({ add: ['skill-a'] }).success).toBe(false)
    expect(NodeSkillOverrideSchema.safeParse({ add: [{ skillId: 'skill-a', version: '3' }], remove: ['skill-a'] }).success).toBe(false)
  })
})

describe('deliverable checks', () => {
  it.each([{ $ref: '#/missing' }, { type: 'string', pattern: '[' }])(
    'returns a configuration issue for an invalid saved schema: %j', schema => {
      expect(checkDeliverable('answer', schema)).toMatchObject([{ code: 'OUTPUT_SCHEMA_INVALID' }])
    },
  )
  it('requires a present deliverable when no schema is declared', () => {
    expect(checkDeliverable('Finished the review.', undefined)).toEqual([])
    expect(checkDeliverable({}, undefined)).toEqual([])
    expect(checkDeliverable('   ', undefined)).toEqual([expect.objectContaining({ code: 'OUTPUT_SCHEMA_MISMATCH' })])
    expect(checkDeliverable(null, undefined)).toEqual([expect.objectContaining({ code: 'OUTPUT_SCHEMA_MISMATCH' })])
  })

  it('reports every schema violation with its JSON pointer path', () => {
    const issues = checkDeliverable({ status: 'ok' }, statusSummary)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every(issue => issue.code === 'OUTPUT_SCHEMA_MISMATCH' && issue.message.length > 0)).toBe(true)
    expect(issues.map(issue => issue.path)).toContain('/summary')
    expect(checkDeliverable({ status: 'ok', summary: 'Done.' }, statusSummary)).toEqual([])
  })

  it('lists ciTicket references from properties and array items with their values', () => {
    const schema = {
      type: 'object',
      properties: {
        primary: { type: 'string', 'x-foreman-reference': 'ciTicket' },
        related: { type: 'array', items: { type: 'string', 'x-foreman-reference': 'ciTicket' } },
      },
    }
    const deliverable = { primary: 'run-1', related: ['run-2', 'run-3'] }
    expect(deliverableReferences(schema, deliverable)).toEqual([
      { kind: 'ciTicket', value: 'run-1', path: '/primary' },
      { kind: 'ciTicket', value: 'run-2', path: '/related/0' },
      { kind: 'ciTicket', value: 'run-3', path: '/related/1' },
    ])
  })
})
