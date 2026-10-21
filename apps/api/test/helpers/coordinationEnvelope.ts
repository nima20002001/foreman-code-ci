import type { HarnessExecutionRequest } from '@foreman-code/contracts'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type Envelope = { routing?: Json; data: Json }

/** Started Runs pin the coordination result protocol, so their Agents answer with summary and board
 * beside the routing and data. Seeded Runs keep the historical plain answer: the routing envelope
 * when there is routing, otherwise the bare data. */
export function answerForRun(request: HarnessExecutionRequest, answer: Envelope) {
  if (!request.resultProtocol) return answer.routing === undefined ? answer.data : answer
  return { ...answer, summary: 'Completed the assigned work.', board: { kind: 'none' as const,
    reason: request.configuration.graphqlTools?.some(tool => tool.startsWith('memory_')) ? 'no_changes' as const : 'no_access' as const } }
}
