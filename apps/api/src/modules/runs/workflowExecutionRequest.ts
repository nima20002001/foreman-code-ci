import {
  HarnessExecutionRequestSchema,
  type AgentConfigurationVersion,
  type HarnessExecution,
  type HarnessExecutionContext,
} from '@foreman-code/contracts'
import { WorkActivationInputSchema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { currentInitialPrompt } from './currentRouting.js'
import { trustedWorkNoticePrompt } from './workHandoffNotice.js'
import { repeatTickIndex } from './repeatResolution.js'

function every(seconds: number | undefined): string {
  if (!seconds) return 'on an interval'
  if (seconds % 3600 === 0) return `every ${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`
  if (seconds % 60 === 0) return `every ${seconds / 60} minute${seconds === 60 ? '' : 's'}`
  return `every ${seconds} seconds`
}

/** Request-only text for one loop of an Agent. Earlier work is in the continued session when one exists. */
function intervalCheckPrompt(index: number, interval: { everySeconds: number; prompt?: string | undefined } | undefined,
  continued: boolean, initialPrompt?: string): string {
  return [
    ...(initialPrompt ? ['Background from the initial activation (already assigned; do not repeat it):', initialPrompt, ''] : []),
    `Foreman Code loop ${index}. While this Run is active you are re-activated ${every(interval?.everySeconds)}.`,
    ...(interval?.prompt ? [`Each loop: ${interval.prompt}`,
      'run_status_get reads your own Run: each node\'s state, the Run\'s CI tickets and recent errors.'] : [
      'Call run_status_get to read your own Run: each node\'s state, the Run\'s CI tickets and recent errors.',
      `${continued ? 'Review your own earlier work too, and look' : 'Look'} for common problems: failed or stuck nodes, failing CI, repeated errors.`]),
    'Report briefly what you found and anything that needs attention. This loop does not route the workflow;',
    'your reply is recorded for this Run but is not passed to other nodes.',
  ].join('\n')
}

export function workflowExecutionRequest(input: {
  execution: HarnessExecution
  version: WorkflowVersionV3
  configuration: AgentConfigurationVersion
  workspaceId: string
  executionContext?: HarnessExecutionContext | undefined
}) {
  const { execution, version, configuration, workspaceId, executionContext } = input
  const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
  if (!node || node.kind === 'job') throw new Error('Native execution requires an Agent workflow node.')
  const tickIndex = repeatTickIndex(execution.input)
  const initialPrompt = tickIndex !== undefined
    ? intervalCheckPrompt(tickIndex, node.interval, Boolean(execution.sessionContinuation),
      execution.sessionContinuation ? undefined : node.initialPrompt)
    : currentInitialPrompt(node,
      version.definition.repeat?.blocks.some(block => block.exitNodeId === node.id) ?? false,
      version.definition.handoffs !== undefined)
  const workInput = version.definition.handoffs && tickIndex === undefined
    ? WorkActivationInputSchema.parse(execution.input) : undefined
  const noticePrompt = workInput ? trustedWorkNoticePrompt(workInput) : undefined
  const nameOf = (nodeId: string) => {
    const item = version.definition.nodes.find(candidate => candidate.id === nodeId)
    return JSON.stringify(item && item.kind !== 'job' ? item.name ?? item.label ?? nodeId : nodeId)
  }
  // Without saved choices, finish follows every outgoing execution edge; a return never does.
  const downstream = node.choice ? [] : version.definition.edges
    .filter(edge => edge.kind === 'execution' && edge.source === node.id).map(edge => nameOf(edge.target))
  const returnPrompt = workInput?.work.kind === 'work_request' ? [
    ...(downstream.length ? [
      `To hand your deliverable to the next Agent (${downstream.join(', ')}), use {"kind":"finish"} with empty remainingFindings.`,
      `A return goes back to ${nameOf(workInput.work.request.requesterNodeId)} only and never starts ${downstream.join(', ')}.`,
    ] : []),
    `Use routing.kind "return" only to answer ${nameOf(workInput.work.request.requesterNodeId)} about the work it sent you: an accepted return closes that request and ends this branch; needs_changes sends it back for another revision.`,
    'If you choose routing.kind "return", copy this routing object and add outcome "accepted" or "needs_changes":',
    JSON.stringify({ kind: 'return', requestId: workInput.work.request.requestId }),
    'requestId may be omitted when replying to the single open request you received. If supplied, copy it verbatim.',
  ].join('\n') : undefined
  const prompts = [initialPrompt, noticePrompt, returnPrompt].filter(Boolean)
  return HarnessExecutionRequestSchema.parse({
    executionId: execution.id,
    runId: execution.runId,
    workspaceId,
    workflowNodeId: execution.workflowNodeId,
    workingDirectory: execution.workingDirectory,
    runtimeDirectory: execution.runtimeDirectory,
    ...(execution.systemPrompt ? { systemPrompt: execution.systemPrompt } : {}),
    ...(prompts.length ? { initialPrompt: prompts.join('\n\n') } : {}),
    configuration,
    input: execution.input,
    ...(executionContext ? { executionContext } : {}),
  })
}
