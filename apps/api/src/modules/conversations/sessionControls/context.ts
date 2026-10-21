import type { ContextSnapshot } from '@foreman-code/contracts'

export function mergeContextSnapshot(previous: ContextSnapshot | null, incoming: ContextSnapshot,
  sessionId: string, model: string | null): ContextSnapshot | null {
  if (incoming.nativeSessionId !== sessionId || model !== null && incoming.model !== model) return previous
  if (!previous || previous.nativeSessionId !== sessionId || previous.model !== incoming.model) return incoming
  if (incoming.generation === previous.generation && incoming.sequence < previous.sequence) return previous
  if (incoming.generation !== previous.generation && incoming.observedAt < previous.observedAt) return previous
  if (incoming.generation === previous.generation && incoming.sequence === previous.sequence
    && incoming.usedTokens === previous.usedTokens && incoming.capacityTokens === previous.capacityTokens
    && incoming.lifetimeTokens === previous.lifetimeTokens && incoming.cost === previous.cost
    && incoming.stale === previous.stale) return previous
  return incoming
}
