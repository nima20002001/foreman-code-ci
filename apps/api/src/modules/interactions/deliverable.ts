import { ExecutionResultSchema, parseCoordinationResult, type CoordinationResultContext, type ExecutionResult } from '@foreman-code/contracts'
import {
  OUTPUT_MISMATCH_CODE, OUTPUT_REFERENCE_KEYWORD, OUTPUT_REFERENCE_UNKNOWN_CODE, OUTPUT_SCHEMA_INVALID_CODE,
  checkDeliverable, deliverableReferences,
  type DeliverableIssue, type OutputReferenceKind, type OutputSchema,
} from '@foreman-code/contracts/wave25'
import { HarnessExecutionError } from '../harnesses/errors.js'

/** Where a workflow Agent's deliverable sits in its successful result: text is the plain final answer;
 * data is a choice or artifactOutputs envelope's data; latestDeliverable is a handoff or repeat exit's data.latestDeliverable. */
export type DeliverableSource = 'text' | 'data' | 'latestDeliverable'

/** Per-execution deliverable contract. Omitting values lists all references this execution created. */
export interface DeliverableContract {
  coordination?: CoordinationResultContext
  source: DeliverableSource
  outputSchema?: OutputSchema | undefined
  referencesExist(kind: OutputReferenceKind, values?: readonly string[]): Promise<ReadonlySet<string>>
}

export interface DeliverableVerdict {
  code: typeof OUTPUT_MISMATCH_CODE | typeof OUTPUT_REFERENCE_UNKNOWN_CODE
  issues: DeliverableIssue[]
  referenceHints?: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(text: string): { value: unknown } | undefined {
  try { return { value: JSON.parse(text) } } catch { return undefined }
}

/** The value to judge, or undefined when nothing is judged here. A malformed routing envelope stays
 * the routing validator's failure; only the deliverable inside a well-formed envelope is checked. */
function deliverableOf(output: unknown, contract: DeliverableContract): { value: unknown } | 'not-json' | undefined {
  // Native harnesses return { text }; any other output is structured and is judged as it stands.
  const text = isObject(output) && Object.keys(output).length === 1 && typeof output.text === 'string' ? output.text : undefined
  if (contract.source === 'text') {
    if (text === undefined || !contract.outputSchema) return { value: text ?? output }
    return parseJson(text) ?? 'not-json'
  }
  const envelope = text === undefined ? output : parseJson(text)?.value
  if (!isObject(envelope)) return undefined
  // Choice and artifact data may be null by their own contract, so only a declared schema judges it.
  if (contract.source === 'data') return contract.outputSchema ? { value: envelope.data } : undefined
  return isObject(envelope.data) ? { value: envelope.data.latestDeliverable } : undefined
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row++) {
    const current = [row]
    for (let column = 1; column <= right.length; column++) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1)
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution)
    }
    previous = current
  }
  return previous[right.length]!
}

function referenceHint(kind: OutputReferenceKind, value: string, available: ReadonlySet<string>): string {
  const limit = 50
  const closest = [...available].map(id => ({ id, distance: editDistance(value, id) }))
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
    .slice(0, limit).map(reference => reference.id)
  const omitted = available.size - closest.length
  const suffix = omitted > 0 ? ` (${omitted} more omitted)` : ''
  return `Valid ${kind} IDs (closest match first): ${JSON.stringify(closest)}${suffix}`
}

/** Returns undefined when the deliverable passes; otherwise the code and every issue for the repair turn. */
export async function deliverableVerdict(result: ExecutionResult, contract: DeliverableContract): Promise<DeliverableVerdict | undefined> {
  if (result.outcome !== 'succeeded') return undefined
  let deliverable: ReturnType<typeof deliverableOf>
  if (contract.coordination) {
    try {
      const parsed = parseCoordinationResult(result.output, contract.coordination)
      if (contract.coordination.interval) return undefined
      deliverable = contract.source === 'latestDeliverable' && isObject(parsed.data)
        ? { value: parsed.data.latestDeliverable } : { value: parsed.data }
    } catch (error) {
      return { code: OUTPUT_MISMATCH_CODE, issues: [{ code: OUTPUT_MISMATCH_CODE, path: '',
        message: error instanceof Error ? error.message : 'The coordination result is invalid.' }] }
    }
  } else deliverable = deliverableOf(result.output, contract)
  if (deliverable === 'not-json') {
    return { code: OUTPUT_MISMATCH_CODE,
      issues: [{ code: OUTPUT_MISMATCH_CODE, path: '', message: 'The final answer must be one JSON value, without Markdown, that matches the output schema.' }] }
  }
  if (!deliverable) return undefined
  const issues = checkDeliverable(deliverable.value, contract.outputSchema)
  if (issues.some(issue => issue.code === OUTPUT_SCHEMA_INVALID_CODE)) {
    throw new HarnessExecutionError(OUTPUT_SCHEMA_INVALID_CODE,
      `The workflow output schema is invalid. ${issues.map(issue => issue.message).join('; ')}`, false)
  }
  if (issues.length) return { code: OUTPUT_MISMATCH_CODE, issues }
  const references = deliverableReferences(contract.outputSchema, deliverable.value)
  const existing = new Map<OutputReferenceKind, ReadonlySet<string>>()
  const available = new Map<OutputReferenceKind, ReadonlySet<string>>()
  const referenceHints: string[] = []
  for (const kind of new Set(references.map(reference => reference.kind))) {
    const values = [...new Set(references.filter(reference => reference.kind === kind).map(reference => reference.value))]
    existing.set(kind, await contract.referencesExist(kind, values))
  }
  for (const reference of references) {
    if (!existing.get(reference.kind)?.has(reference.value)) {
      issues.push({ code: OUTPUT_REFERENCE_UNKNOWN_CODE, path: reference.path,
        message: `${reference.kind} ${reference.value} was not created by this execution.` })
      let candidates = available.get(reference.kind)
      if (!candidates) {
        candidates = await contract.referencesExist(reference.kind)
        available.set(reference.kind, candidates)
      }
      referenceHints.push(`${reference.path || '/'}: ${referenceHint(reference.kind, reference.value, candidates)}`)
    }
  }
  return issues.length ? { code: OUTPUT_REFERENCE_UNKNOWN_CODE, issues, referenceHints } : undefined
}

/** One corrective turn in the same native session, listing every validation error exactly. */
export function deliverableRepairPrompt(verdict: DeliverableVerdict, outputSchema: OutputSchema | undefined): string {
  return [
    'Your deliverable failed the workflow output contract.',
    `Validation issues: ${JSON.stringify(verdict.issues)}`,
    ...(verdict.referenceHints ?? []),
    'Return the complete corrected final answer in the same format as before. Preserve the valid parts of your deliverable.',
    'This is a corrective turn in the same execution. Do not repeat the task or perform additional work.',
    `Output contract: ${outputSchema ? JSON.stringify(outputSchema) : 'a deliverable that is not empty'}`,
  ].join('\n')
}

/** The non-retryable failed result that replaces the Agent's final answer once its repair turns are used. */
export function deliverableFailure(verdict: DeliverableVerdict): ExecutionResult {
  const detail = verdict.issues.map(issue => `${issue.path || '/'}: ${issue.message}`).join('; ').slice(0, 2000)
  return ExecutionResultSchema.parse({ outcome: 'failed',
    error: { code: verdict.code, message: `The Agent deliverable failed its output contract. ${detail}`, retryable: false } })
}

/** Codex sends turn outputSchema in strict mode, which rejects (HTTP 400) any object schema that allows
 * extra or optional properties. Such schemas are enforced by validation and repair only. */
function codexStrict(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(codexStrict)
  if (!isObject(node)) return true
  if (node.type === 'object' || isObject(node.properties)) {
    const required = Array.isArray(node.required) ? node.required : []
    if (node.additionalProperties !== false || !Object.keys(isObject(node.properties) ? node.properties : {}).every(key => required.includes(key))) return false
  }
  return Object.values(node).every(codexStrict)
}

/** Native structured output for a plain-answer node, without Foreman reference markers. */
export function nativeOutputSchema(contract: DeliverableContract): Record<string, unknown> | undefined {
  // Coordination envelopes include arbitrary JSON and optional mutation variants outside the native strict-schema subset.
  if (contract.coordination) return undefined
  const schema = contract.outputSchema
  if (contract.source !== 'text' || !schema || schema.type !== 'object' || !codexStrict(schema)) return undefined
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip)
    if (!isObject(node)) return node
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== OUTPUT_REFERENCE_KEYWORD).map(([key, value]) => [key, strip(value)]))
  }
  return strip(schema) as Record<string, unknown>
}
