import type { SelectedRunChatSelection } from '@foreman-code/contracts/selected-run-chat'

export function sameSelectedTarget(expected: SelectedRunChatSelection, actual: SelectedRunChatSelection): boolean {
  return expected.workspaceId === actual.workspaceId && expected.workflowId === actual.workflowId
    && expected.runId === actual.runId && expected.workflowNodeId === actual.workflowNodeId
    && (expected.executionId === undefined || expected.executionId === actual.executionId)
}

/** A mount lease supplements the URL's visit ticket. Old callbacks cannot revive on A -> B -> A. */
export function createChatVisit(isSelected: () => boolean) {
  let epoch = 0, mounted = true
  return {
    mount() { mounted = true; return () => { mounted = false; epoch++ } },
    capture() { const ticket = epoch; return () => mounted && ticket === epoch && isSelected() },
    isCurrent() { return mounted && isSelected() },
  }
}
