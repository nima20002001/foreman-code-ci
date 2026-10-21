import { canonicalGraphJson, WORK_RETURN_MAX_BYTES, type HierarchyWorkGroup, type WorkActivationInput,
  type WorkRequest } from '@foreman-code/contracts/wave25'

const INPUT_BYTES = 4 * 1024 * 1024
const encoder = new TextEncoder()
function bytes(value: unknown): number {
  return encoder.encode(canonicalGraphJson(value, INPUT_BYTES)).byteLength
}

/** Reserve enough input space before admitting any child. Full original Run input
 * and parent ancestry are retained; no later combination of bounded feedback can
 * strand the pre-reserved parent. Controls are the worst JSON-escaped summaries. */
export function hasHierarchyParentInputCapacity(group: HierarchyWorkGroup,
  activation: WorkActivationInput['work']['activation'], runInput: unknown,
  members: readonly { requestId: string; destinationNodeId: string }[], parentRequest?: WorkRequest): boolean {
  const summary = '\u0001'.repeat(300), maximumId = 'x'.repeat(200)
  try {
    let size = bytes({ executionSemanticsVersion: 3, runInput, occurrence: null, entry: null, predecessors: [],
      ...(parentRequest ? { parentRequest } : {}),
      work: { kind: 'hierarchy_group', activation, group, returns: [], failures: [] } })
    for (const member of members) {
      const returned = { ...member, returnId: maximumId, sourceActivationId: maximumId, sourceExecutionId: maximumId,
        resultDigest: `sha256:${'0'.repeat(64)}`, outcome: 'needs_changes',
        continuationActivationId: activation.activationId, summary, remainingFindingsCount: 1000 }
      const failure = { ...member, executionId: maximumId, outcome: 'canceled', code: '\u0001'.repeat(80), summary }
      // The validated WorkReturn bounds its entire deliverable/findings payload.
      // Feedback also carries a summary and identifiers; one comma covers array separation.
      size += Math.max(bytes(returned) + WORK_RETURN_MAX_BYTES, bytes(failure)) + 1
    }
    return size <= INPUT_BYTES
  } catch {
    // The original input alone can exceed the native bound. Refuse the entire
    // batch before it consumes budget instead of creating unlaunchable work.
    return false
  }
}
