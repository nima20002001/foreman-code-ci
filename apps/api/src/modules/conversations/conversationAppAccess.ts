import { isDeepStrictEqual } from 'node:util'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'

/** Only an Operator's App MCP access may change; its saved owner, profile and directory stay fixed. */
export function sameConversationForAppAccess(previous: WorkerConversationBinding, next: WorkerConversationBinding): boolean {
  return previous.owner.kind === 'operator' && next.owner.kind === 'operator'
    && isDeepStrictEqual({ ...previous, appMcpAccess: next.appMcpAccess }, next)
}
