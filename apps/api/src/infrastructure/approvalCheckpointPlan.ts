/** LangGraph's task-local __resume__ channel is an ordered array. Several
 * interactions can share the CURRENT interrupt, but only one value may consume
 * it. Appending once per interaction would approve a later, unrelated interrupt.
 * This helper has no I/O and never decides whether a delivery is authorized.
 */
export function nextApprovalResumeValues(previous: unknown, currentInteractionIds: readonly string[],
  deliveredInteractionId: string): { values: unknown[]; changed: boolean } {
  if (!Array.isArray(previous) || previous.length > 1000 || !currentInteractionIds.length
    || currentInteractionIds.length > 1000 || new Set(currentInteractionIds).size !== currentInteractionIds.length
    || currentInteractionIds.some((id) => typeof id !== 'string' || !id)
    || !currentInteractionIds.includes(deliveredInteractionId)) throw new Error('GRAPH_INTERRUPT_INVALID')
  const consumed = previous.some((value) => value !== null && typeof value === 'object'
    && !Array.isArray(value) && 'interactionId' in value && typeof value.interactionId === 'string'
    && currentInteractionIds.includes(value.interactionId))
  if (consumed) return { values: previous, changed: false }
  if (previous.length === 1000) throw new Error('GRAPH_RESUME_LIMIT')
  return { values: [...previous, { interactionId: deliveredInteractionId }], changed: true }
}
