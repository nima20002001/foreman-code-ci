import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import type { AcceptedNodePlacement, SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { PlacementCommitFence } from './admission.js'

/** Node identity and the complete frozen placement are checked for every node.
 * Only SQL guards with identical inputs share reads, within this invocation. */
export function startPlacementFence(
  validate: (pin: AcceptedNodePlacement) => {
    configuration: AgentConfigurationVersion; implicit: boolean; saved: SavedNodePlacement
  },
  assertCurrent: (pin: AcceptedNodePlacement) => Promise<void>,
): PlacementCommitFence {
  return {
    assertCurrent: async pin => {
      validate(pin)
      await assertCurrent(pin)
    },
    assertAllCurrent: async pins => {
      // Each pre-commit invocation must read live facts again.
      const checked = new Set<string>()
      for (const pin of pins) {
        const saved = validate(pin)
        const payload = pin.payload
        if (payload.kind !== 'agent') {
          await assertCurrent(pin)
          continue
        }
        const harness = Object.fromEntries(Object.entries(payload).filter(([field]) =>
          !['agentId', 'agentConfigurationVersionId', 'worktree', 'artifactOutputs'].includes(field)))
        const key = canonicalGraphJson({ mainId: pin.mainId, mainInstallationId: pin.mainInstallationId,
          hostRef: pin.hostRef, registration: pin.registration, destination: pin.destination,
          source: pin.source, harness, implicit: saved.implicit, saved: saved.saved,
          configuration: saved.configuration.harness,
          selection: saved.configuration.harnessProfileSelection ?? null })
        if (checked.has(key)) continue
        await assertCurrent(pin)
        checked.add(key)
      }
    },
  }
}
