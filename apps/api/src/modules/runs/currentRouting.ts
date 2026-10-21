import type { ExecutionResult, CoordinationResultContext, ResultProtocol } from '@foreman-code/contracts'
import { WorkflowArtifactOutputsV1Schema, type WorkflowArtifactOutputsV1 } from '@foreman-code/contracts/workflow-artifact-result'
import {
  AcceptedCurrentNodeResultSchema, OUTPUT_REFERENCE_KEYWORD, WorkflowChoiceSchema, parseChoiceResultEnvelope,
  type WorkflowChoice, type ChoiceResultEnvelope,
} from '@foreman-code/contracts/wave25'

/** Parsing-only native text view; the complete original result remains the
 * accepted/digested evidence. No prefix salvage, Markdown or mixed carriers. */
export function parseCurrentChoiceResult(result: ExecutionResult, choice: WorkflowChoice,
  artifactOutputs?: WorkflowArtifactOutputsV1, context?: CoordinationResultContext): ChoiceResultEnvelope {
  AcceptedCurrentNodeResultSchema.parse(result)
  if (artifactOutputs) return parseChoiceResultEnvelope(result, choice, artifactOutputs, context)
  const output = result.outcome === 'succeeded' ? result.output : undefined
  if (output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string') {
    return parseChoiceResultEnvelope({ ...result, output: output.text }, choice, artifactOutputs, context)
  }
  return parseChoiceResultEnvelope(result, choice, artifactOutputs, context)
}

/** Request-only instructions derived from the immutable node. Never mutate the
 * saved configuration, accepted input, model settings, or routing authority. */
export function currentInitialPrompt(node: { initialPrompt?: string | undefined; choice?: WorkflowChoice | undefined;
  artifactOutputs?: WorkflowArtifactOutputsV1 | undefined; outputSchema?: Record<string, unknown> | undefined },
  repeatExit = false, handoff = false, protocol?: ResultProtocol): string | undefined {
  const base = basePrompt(node, repeatExit, handoff, protocol)
  const prompt = protocol ? [base, coordinationResultInstructions()].filter(Boolean).join('\n\n') : base
  if (!node.outputSchema) return prompt
  const where = handoff || repeatExit ? 'data.latestDeliverable of your result'
    : node.choice || node.artifactOutputs || protocol ? 'data of your result' : 'your final answer, as one JSON value with no Markdown'
  const schema = JSON.stringify(node.outputSchema)
  const contract = [
    'Foreman Code deliverable schema (version 1).',
    `The deliverable, ${where}, must validate against this JSON Schema: ${schema}`,
    ...(schema.includes(`"${OUTPUT_REFERENCE_KEYWORD}"`)
      ? [`A property marked "${OUTPUT_REFERENCE_KEYWORD}": "ciTicket" must hold the ID of a CI run that this execution started.`] : []),
    'Invalid deliverables are returned for correction, at most twice, before the attempt fails.',
    'End Foreman Code deliverable schema contract.',
  ].join('\n')
  return prompt ? `${prompt}\n\n${contract}` : contract
}

function resultKeys(business: string[], protocol?: ResultProtocol): string {
  const keys = protocol ? [...business, 'summary', 'board'] : business
  if (keys.length === 2) return `${keys[0]} and ${keys[1]}`
  return `${keys.slice(0, -1).join(', ')}, and ${keys.at(-1)}`
}

function basePrompt(node: { initialPrompt?: string | undefined; choice?: WorkflowChoice | undefined;
  artifactOutputs?: WorkflowArtifactOutputsV1 | undefined }, repeatExit: boolean, handoff: boolean, protocol?: ResultProtocol): string | undefined {
  if (handoff) {
    const saved = node.artifactOutputs ? WorkflowArtifactOutputsV1Schema.parse(node.artifactOutputs) : undefined
    const outcomes = node.choice ? WorkflowChoiceSchema.parse(node.choice).outcomes.map(({ outcome }) => outcome) : []
    const contract = [
      'Foreman Code work-handoff result contract (version 1)',
      `On successful completion, return exactly one complete JSON object with exactly ${resultKeys(['routing', 'data', ...(saved ? ['artifactOutputs'] : [])], protocol)}.`,
      'routing.kind is request, return, or finish.',
      `For a NEW work request, use {"kind":"request","outcome":<one of ${JSON.stringify(outcomes)}>}; only saved named outcomes are permitted.`,
      'A request routing object has exactly kind and outcome. Never include requestId in a new request; requestId belongs only to return routing.',
      'After reactivation, use executionContext.parentRequest.requestId from the trusted workflow execution context for the outstanding caller.',
      'If executionContext.parentRequest is null, this activation has no outstanding caller.',
      'For a work_request activation, use work.request.requestId.',
      'For correlated feedback, use {"kind":"return","requestId":<the exact request ID in your received work>,"outcome":"accepted" or "needs_changes"}.',
      'requestId may be omitted when replying to the single open request you received. The app resolves that request; when several are open, requestId is required. A supplied requestId must match an open received request.',
      'An accepted return approves the deliverable. Any remaining findings are preserved for direction and do not automatically reactivate the requester. Use needs_changes to request another revision.',
      'To finish this activation, use {"kind":"finish"}; without saved choices and with empty remainingFindings this hands latestDeliverable to every saved downstream Agent. On a choice node this ends the branch without selecting a downstream route. Include a declared outcome to select a final downstream branch. Include unresolved findings honestly.',
      'data has exactly latestDeliverable (a non-null JSON value) and remainingFindings (an array of JSON values).',
      'remainingFindings lists unresolved task requirements, defects, or blockers that need further work or owner direction. Use [] when the assigned work is complete.',
      'Finishing or returning accepted with non-empty remainingFindings makes the Run wait for owner direction; it does not mean successful completion of the workflow.',
      'Put verification status, tests not run, intentionally deferred checks assigned to another lane, and handoff notes in latestDeliverable. They are remainingFindings only when they leave an assigned task requirement unresolved.',
      'If the requested change is already implemented, report its existing commit and verification status in latestDeliverable; do not invent a finding or create a redundant commit merely to report completion.',
      ...(saved ? [
        `Required saved output keys: ${JSON.stringify(saved.outputKeys)}`,
        'artifactOutputs has exactly version: 1 and outputs: an array containing each required key exactly once.',
        'Use files_native_output_create, files_native_output_append, files_native_output_seal, then files_native_output_publish to produce each original artifact. These tools supply the execution scope and transfer the sealed bytes.',
        'Each output entry has exactly outputKey and commandId. Use the exact commandId of that original native turn’s successful files.publish_transferred_result call.',
        'Admit, transfer, and publish the original bytes before completing. The backend verifies canonical bytes and durable output mappings.',
        'Do not invent command IDs, select latest files, reuse another execution’s publication, or claim success for an unpublished required output.',
      ] : []),
      'Do not invent request IDs, connection IDs, destinations, approval outcomes or permissions. The backend validates saved routes.',
      'Do not wrap JSON in Markdown, commentary or partial output. The complete result must be at most 65536 UTF-8 bytes.',
      'Return and handoff-limit notice metadata must also fit that limit. The backend checks delivery size before accepting success; keep deliverables concise or use artifact references.',
      'End Foreman Code work-handoff result contract.',
    ].join('\n')
    return node.initialPrompt ? `${node.initialPrompt}\n\n${contract}` : contract
  }
  if (node.artifactOutputs) {
    const saved = WorkflowArtifactOutputsV1Schema.parse(node.artifactOutputs)
    const outcomes = node.choice ? WorkflowChoiceSchema.parse(node.choice).outcomes.map(item => item.outcome) : undefined
    const contract = [
      'Foreman Code saved workflow artifact result contract (version 1)',
      `Required saved output keys: ${JSON.stringify(saved.outputKeys)}`,
      `On success return exactly one complete JSON object with ${resultKeys([...(outcomes ? ['routing'] : []), 'data', 'artifactOutputs'], protocol)}.`,
      ...(outcomes ? [`routing has exactly outcome, one of ${JSON.stringify(outcomes)}.`] : []),
      'artifactOutputs has exactly version: 1 and outputs: an array containing each required key exactly once.',
      'Use files_native_output_create, files_native_output_append, files_native_output_seal, then files_native_output_publish to produce each original artifact. These tools supply the execution scope and transfer the sealed bytes.',
      'Each output entry has exactly outputKey and commandId. Use the exact commandId of that original native turn’s successful files.publish_transferred_result call.',
      'Admit, transfer, and publish the original bytes before completing. A command ID alone does not prove publication; the backend verifies canonical bytes and durable output mappings.',
      'Do not invent command IDs, select latest files, reuse another execution’s publication, or claim success for an unpublished required output.',
      'data is a JSON value. Preserve the accepted task data requirements. Do not wrap the complete JSON in Markdown or commentary. Maximum 65536 UTF-8 bytes.',
      'End Foreman Code saved workflow artifact result contract.',
    ].join('\n')
    return node.initialPrompt ? `${node.initialPrompt}\n\n${contract}` : contract
  }
  if (!node.choice) return protocol
    ? [node.initialPrompt, 'On successful completion return exactly one JSON object with data, summary, and board.'].filter(Boolean).join('\n\n')
    : node.initialPrompt
  const choice = WorkflowChoiceSchema.parse(node.choice)
  // The schema bounds this list to 16 unique, injection-free names of <=48 chars.
  // Targets remain private backend authority: no relationship IDs are supplied.
  const outcomes = choice.outcomes.map(({ outcome }) => outcome)
  const contract = [
    'Foreman Code finite-choice output contract (version 1)',
    `Allowed routing.outcome values: ${JSON.stringify(outcomes)}`,
    `On successful completion, return exactly one complete JSON object with ${protocol ? 'routing, data, summary, and board' : 'exactly two keys: routing and data'}.`,
    'routing must be an object with exactly one key, outcome, whose value is one of the allowed strings above.',
    repeatExit
      ? 'data must be an object with exactly latestDeliverable (a non-null JSON value) and remainingFindings (an array of JSON values). Preserve the latest deliverable and any unresolved findings on both exit outcomes.'
      : 'data must be a JSON value and may be null. Do not add keys to routing or to the outer object.',
    'Do not wrap the result in Markdown, code fences, commentary, or a string containing partial JSON.',
    'The entire JSON result must be at most 65536 UTF-8 bytes.',
    'Select an outcome only. Do not return edge IDs, successor IDs, or an execution plan; the backend resolves the saved targets.',
    `Envelope example (shape only, not a preferred outcome): ${JSON.stringify({ routing: { outcome: outcomes[0] }, data: repeatExit ? { latestDeliverable: {}, remainingFindings: [] } : null, ...(protocol ? { summary: 'Result summary', board: { kind: 'none', reason: 'no_changes' } } : {}) })}`,
    'End Foreman Code finite-choice output contract.',
  ].join('\n')
  return node.initialPrompt ? `${node.initialPrompt}\n\n${contract}` : contract
}

export function coordinationResultInstructions(): string {
  return [
    'Foreman Code coordination result protocol f1-f4-v1.',
    'summary is a nonempty string of at most 600 characters. data contains only the business deliverable.',
    'board is required: {"kind":"none","reason":"no_changes"}, {"kind":"none","reason":"no_access"},',
    '{"kind":"none","reason":"already_recorded","appliedCommandIds":[...]}, or {"kind":"changes","operations":[...]}.',
    'Use no_access when memory tools are disabled. Read-only agents cannot supply changes.',
    'Operations use the memory tool mutation schemas, at most 32 per result. Do not repeat changes already committed through tools.',
    'A linked task is completed automatically after all logical work accepts; do not mark active work Done yourself.',
    'Interval checks apply board changes without binding new tasks to the check or completing business work. Select existing business work or Next activation explicitly when needed.',
    'Return one complete JSON object without Markdown. The whole envelope must fit 65536 UTF-8 bytes.',
    'Corrections use the same session, at most twice. Correct the result only; do not repeat external work.',
  ].join('\n')
}
