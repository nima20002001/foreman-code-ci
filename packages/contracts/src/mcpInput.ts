import { z } from 'zod'

const inputs = new WeakMap<z.core.$ZodType, z.core.$ZodType>()

/** Derives MCP-only strip behavior without changing shared HTTP or persisted schemas. */
export function mcpInputSchema<T extends z.core.$ZodType>(schema: T): T {
  const cached = inputs.get(schema)
  if (cached) return cached as T
  const definition: z.core.$ZodTypeDef & Record<string, unknown> = { ...schema._zod.def }
  let changed = false
  if (schema instanceof z.core.$ZodObject) {
    definition.shape = Object.fromEntries(Object.entries(schema._zod.def.shape)
      .map(([name, field]) => [name, mcpInputSchema(field)]))
    definition.catchall = undefined
    changed = true
  } else if (schema instanceof z.core.$ZodLazy) {
    definition.getter = () => mcpInputSchema(schema._zod.def.getter())
    changed = true
  } else {
    // Container definitions hold their children directly or in an options/items array.
    for (const [name, value] of Object.entries(definition)) {
      if (value instanceof z.core.$ZodType) {
        const child = mcpInputSchema(value)
        definition[name] = child
        changed ||= child !== value
      } else if (name === 'options' || name === 'items') {
        const children = value as z.core.$ZodType[]
        const mapped = children.map(child => mcpInputSchema(child))
        definition[name] = mapped
        changed ||= mapped.some((child, index) => child !== children[index])
      }
    }
  }
  const input = changed ? z.clone(schema, definition as T['_zod']['def'], { parent: true }) : schema
  inputs.set(schema, input)
  return input
}
