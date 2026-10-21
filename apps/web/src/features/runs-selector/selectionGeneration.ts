import type { SelectedRunIdentity } from './types'

export type RunSelection = Readonly<{
  identity: SelectedRunIdentity
  active: boolean
  invalid: boolean
}>
export type RunSelectionGeneration = Readonly<{
  /** Unique per subscription lifetime AND per visit, including A -> B -> A. */
  id: string
  identity: SelectedRunIdentity
}>
export type RunSelectionSnapshot = RunSelection & Readonly<{ generation: RunSelectionGeneration }>

let nextSourceId = 0

/** A cached projection of the URL, not a second writable selection store.
 * The only extra state is a response-fencing generation. Subscribe to history,
 * not a render effect: even two navigations batched into one render invalidate
 * the first A. Object identity prevents tickets from another hook being reused.
 */
export function createRunSelectionSource(
  read: () => RunSelection,
  subscribeToLocation: (notify: () => void) => () => void,
) {
  const sourceId = ++nextSourceId
  let revision = 0
  let current: RunSelectionSnapshot | undefined
  let key: string | undefined
  const listeners = new Set<() => void>()
  let unsubscribe: (() => void) | undefined

  function getSnapshot(): RunSelectionSnapshot {
    const selection = read()
    const nextKey = JSON.stringify([selection.identity.workspaceId, selection.identity.workflowId,
      selection.identity.runId, selection.active, selection.invalid])
    if (!current || key !== nextKey) {
      key = nextKey
      const identity = Object.freeze({ ...selection.identity })
      current = Object.freeze({ ...selection, identity,
        generation: Object.freeze({ id: `${sourceId}:${++revision}`, identity }) })
    }
    return current
  }

  function changed() {
    const previous = current
    if (getSnapshot() !== previous) for (const notify of listeners) notify()
  }

  return {
    getSnapshot,
    subscribe(notify: () => void) {
      listeners.add(notify)
      if (listeners.size === 1) unsubscribe = subscribeToLocation(changed)
      changed()
      return () => {
        listeners.delete(notify)
        if (listeners.size === 0) {
          unsubscribe?.()
          unsubscribe = undefined
          // Also fence unmount and React StrictMode's subscription replay.
          current = undefined
          key = undefined
        }
      }
    },
    isCurrent(ticket: RunSelectionGeneration) {
      if (listeners.size === 0) return false
      const snapshot = getSnapshot()
      return snapshot.active && !snapshot.invalid && snapshot.generation === ticket
    },
  }
}
