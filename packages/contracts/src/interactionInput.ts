import { z } from 'zod'
import { Validator, type SchemaDraft } from '@cfworker/json-schema'

export const NativeQuestionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isOther: z.boolean().default(false),
  isSecret: z.boolean().default(false),
  options: z.array(z.object({ label: z.string(), description: z.string() }).strict()).nullable().default(null),
}).strict()

export const NativeInteractionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('questions'), questions: z.array(NativeQuestionSchema) }).strict(),
  z.object({ kind: z.literal('form'), schema: z.union([z.boolean(), z.record(z.string(), z.json())]) }).strict(),
])
export type NativeInteractionInput = z.infer<typeof NativeInteractionInputSchema>
export type InteractionResponseValue = z.infer<ReturnType<typeof z.json>>

type ResponseOption = {
  input?: NativeInteractionInput | undefined
  response?: InteractionResponseValue | undefined
}

function schemaDraft(schema: Record<string, unknown>): SchemaDraft {
  const dialect = String(schema.$schema ?? '')
  if (dialect.includes('draft-04')) return '4'
  if (dialect.includes('draft-07')) return '7'
  if (dialect.includes('2019-09')) return '2019-09'
  return '2020-12'
}

/** Validate without transforming the caller's data or supplying missing values. */
export function validateInteractionResponse(input: NativeInteractionInput | undefined, response: unknown): void {
  if (!input) {
    z.undefined().parse(response)
    return
  }
  if (input.kind === 'form') {
    const dialect = typeof input.schema === 'boolean' ? '2020-12' : schemaDraft(input.schema)
    const validator = new Validator(structuredClone(input.schema), dialect, false)
    const result = validator.validate(response)
    if (!result.valid) throw new z.ZodError(result.errors.map((error) => ({
      code: 'custom' as const,
      path: error.instanceLocation.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')),
      message: error.error,
    })))
    return
  }
  const fields = Object.fromEntries(input.questions.map((question) => {
    const labels = question.options?.map((option) => option.label)
    const answer = z.string().refine((value) => !labels?.length || question.isOther || labels.includes(value),
      { message: 'Choose an offered answer' })
    return [question.id, z.object({ answers: z.array(answer).min(1) }).strict()]
  }))
  z.object(fields).strict().parse(response)
}

export function withInteractionResponse<T extends ResponseOption>(option: T, response: unknown): T & ResponseOption {
  const values = response === undefined && option.input?.kind === 'form' ? {} : response
  validateInteractionResponse(option.input, values)
  if (!option.input) return option
  return { ...option, response: z.json().parse(values) }
}
