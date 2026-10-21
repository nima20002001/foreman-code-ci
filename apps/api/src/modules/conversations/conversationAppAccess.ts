import { isDeepStrictEqual } from 'node:util'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'

/** Agent transitions only remove access; every saved owner, profile and directory pin remains fixed. */
export function sameConversationForAppAccess(previous: WorkerConversationBinding, next: WorkerConversationBinding): boolean {
  const operator = previous.owner.kind === 'operator' && next.owner.kind === 'operator'
  const reduction = previous.owner.kind === 'agent' && next.owner.kind === 'agent'
    && previous.appMcpAccess === 'scoped' && next.appMcpAccess === 'none'
  return (operator || reduction)
    && isDeepStrictEqual({ ...previous, appMcpAccess: next.appMcpAccess }, next)
}
