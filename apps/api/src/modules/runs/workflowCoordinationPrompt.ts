import type { CoordinationResultContext } from '@foreman-code/contracts'
import { OUTPUT_REFERENCE_KEYWORD } from '@foreman-code/contracts/wave25'

/** Request-only contract for marked Runs. Historical producers retain their
 * exact existing prompts and output schema behavior. */
export function workflowCoordinationPrompt(context: CoordinationResultContext): string {
  const node = context.definition.nodes.find(item => item.id === context.workflowNodeId)
  if (!node || node.kind === 'job') throw new Error('COORDINATION_AGENT_NODE_REQUIRED')
  const handoff = !context.interval && context.definition.handoffs !== undefined
  const hierarchy = handoff && context.definition.hierarchy
  const choice = context.interval ? undefined : node.choice
  const artifacts = context.interval ? undefined : node.artifactOutputs
  const repeatExit = !context.interval && context.definition.repeat?.blocks.some(block => block.exitNodeId === node.id)
  const fields = ['data', 'summary', 'board', ...(handoff || choice ? ['routing'] : []), ...(artifacts ? ['artifactOutputs'] : [])]
  const outcomes = choice?.outcomes.map(item => item.outcome) ?? []
  const routing = handoff ? [
    'routing.kind is request, return, finish' + (hierarchy ? ', or delegate.' : '.'),
    `A new request is {"kind":"request","outcome":<one of ${JSON.stringify(outcomes)}>}. Only saved named routes are permitted.`,
    'A return is {"kind":"return","requestId":<the received request ID>,"outcome":"accepted" or "needs_changes"}.',
    'Use executionContext.parentRequest.requestId or work.request.requestId; null parentRequest means no outstanding caller. Never invent request IDs.',
    'requestId may be omitted only for a single open received request. An accepted return closes that obligation; needs_changes requests another business round.',
    ...(hierarchy ? [
      'A delegation is {"kind":"delegate","requests":[{"outcome":<saved direct-child route>,"data":<that child\'s distinct task JSON>},...]}.',
      'Select each direct child at most once. Only selected children run. All selected child obligations settle before your one reserved continuation runs.',
      'A subordinate with an outstanding caller must return to it. A finish never starts downstream hierarchy nodes.',
      'Only the root Master may finish the workflow, and only after every outstanding request has settled.',
      'Root finish with remaining findings is nonfinal Waiting for direction. Report the findings honestly; the same Run waits for explicit direction.',
    ] : [
      'To finish use {"kind":"finish"}; on a choice node an optional declared outcome selects a final downstream branch.',
      'Without saved choices, finish with empty findings passes work to every saved downstream Agent. A return does not.',
    ]),
  ] : choice ? [`routing has exactly outcome, one of ${JSON.stringify(outcomes)}. The backend resolves the saved target.`] : []
  const where = handoff || repeatExit ? 'data.latestDeliverable' : 'data'
  return [
    'Foreman Code coordinated result contract (f1-f4-v1).',
    `Return exactly one complete JSON object with exactly these keys: ${fields.join(', ')}.`,
    'Do not wrap JSON in Markdown or commentary. The complete envelope is limited to 65536 UTF-8 bytes.',
    'summary is a nonempty trimmed string of at most 600 characters describing this execution result.',
    handoff || repeatExit
      ? 'data has exactly latestDeliverable (a non-null JSON value) and remainingFindings (an array of JSON values).'
      : 'data is the business deliverable as a JSON value.',
    ...routing,
    ...(context.interval ? ['This interval check does not route work. Return only data, summary, and board.'] : []),
    'board is {"kind":"none","reason":"no_changes"}, {"kind":"none","reason":"no_access"}, or {"kind":"none","reason":"already_recorded","appliedCommandIds":[...]} when there are no new effects.',
    'For new board effects use {"kind":"changes","operations":[...]} with 1 to 32 canonical memory-board mutations, using the same complete mutation shapes as the memory-board tools.',
    'When only the user can continue (for example a payment page, sign-in or CAPTCHA), create or update a card with status "waiting_for_user" and a reason that tells the user exactly what to do.',
    'Use only existing scoped board/card/note identities and saved node identities. Already recorded command IDs must be actual receipts; do not replay their mutations.',
    ...(artifacts ? [
      `Required artifact output keys: ${JSON.stringify(artifacts.outputKeys)}.`,
      'artifactOutputs is {"version":1,"outputs":[{"outputKey":<saved key>,"commandId":<original publication command ID>}]} with every required key exactly once.',
      'Create, append, seal, and publish original bytes through files_native_output_* before completing. Never invent a publication or reuse another execution\'s output.',
    ] : []),
    ...(!context.interval && node.outputSchema ? [
      `Only ${where} must validate against this saved JSON Schema: ${JSON.stringify(node.outputSchema)}.`,
      `A ${OUTPUT_REFERENCE_KEYWORD}:ciTicket reference must identify a CI run this execution started.`,
    ] : []),
    'Invalid envelopes or deliverables receive at most two corrective turns in this same native session; do not repeat the assigned work during correction.',
    'End Foreman Code coordinated result contract.',
  ].join('\n')
}
