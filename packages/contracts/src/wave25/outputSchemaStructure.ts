import { dereference, type Schema } from '@cfworker/json-schema'
import { z } from 'zod'

const pattern = z.string().refine(value => {
  try {
    new RegExp(value, 'u')
    return true
  } catch {
    return false
  }
}, 'invalid regular expression')
const types = z.enum(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])
const strings = z.array(z.string()).refine(values => new Set(values).size === values.length, 'values must be unique')
const count = z.number().int().nonnegative()
const schema: z.ZodType = z.lazy(() => z.union([
  z.boolean(),
  z.looseObject({
    $id: z.string().optional(), $schema: z.string().optional(), $anchor: z.string().optional(),
    $ref: z.string().startsWith('#').optional(),
    // These reference dialects are not implemented by the deliverable validator.
    $recursiveRef: z.never().optional(), $dynamicRef: z.never().optional(),
    type: z.union([types, z.array(types).min(1).refine(values => new Set(values).size === values.length)]).optional(),
    enum: z.array(z.json()).min(1).optional(),
    required: strings.optional(), dependentRequired: z.record(z.string(), strings).optional(),
    properties: z.record(z.string(), schema).optional(),
    patternProperties: z.record(pattern, schema).optional(),
    $defs: z.record(z.string(), schema).optional(), definitions: z.record(z.string(), schema).optional(),
    dependentSchemas: z.record(z.string(), schema).optional(),
    dependencies: z.record(z.string(), z.union([schema, strings])).optional(),
    items: schema.optional(), prefixItems: z.array(schema).optional(),
    additionalItems: schema.optional(), unevaluatedItems: schema.optional(), contains: schema.optional(),
    additionalProperties: schema.optional(), unevaluatedProperties: schema.optional(), propertyNames: schema.optional(),
    allOf: z.array(schema).min(1).optional(), anyOf: z.array(schema).min(1).optional(),
    oneOf: z.array(schema).min(1).optional(), not: schema.optional(),
    if: schema.optional(), then: schema.optional(), else: schema.optional(),
    minimum: z.number().optional(), maximum: z.number().optional(),
    exclusiveMinimum: z.number().optional(), exclusiveMaximum: z.number().optional(),
    multipleOf: z.number().positive().optional(),
    minLength: count.optional(), maxLength: count.optional(), pattern: pattern.optional(), format: z.string().optional(),
    minItems: count.optional(), maxItems: count.optional(), uniqueItems: z.boolean().optional(),
    minContains: count.optional(), maxContains: count.optional(),
    minProperties: count.optional(), maxProperties: count.optional(),
  }),
]))

export function outputSchemaStructureProblems(value: Record<string, unknown>): { path: string[]; message: string }[] {
  const parsed = schema.safeParse(value)
  if (!parsed.success) return parsed.error.issues.map(issue => ({ path: issue.path.map(String), message: issue.message }))
  try {
    const lookup = dereference(structuredClone(value) as Schema)
    for (const [uri, child] of Object.entries(lookup)) {
      if (typeof child === 'object' && child.$ref !== undefined
        && lookup[new URL(child.$ref, uri).href] === undefined) {
        return [{ path: ['$ref'], message: `unresolved local $ref: ${child.$ref}` }]
      }
    }
    return []
  } catch (error) {
    return [{ path: [], message: error instanceof Error ? error.message : 'invalid output schema' }]
  }
}
