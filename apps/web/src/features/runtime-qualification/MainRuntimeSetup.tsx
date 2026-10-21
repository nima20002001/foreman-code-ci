import { Button } from '../../shared/ui/nocturne'
import { askOperator } from '../operator-chat/operatorChatStore'

/** Human-only step: the protected CI runtime on Main is installed locally; the Operator captures and qualifies it after. */
export function MainRuntimeSetup() {
  return <section className="computer-action-card" aria-label="Main runtime setup">
    <h2>Main PC build runtime</h2>
    <Button size="sm" onClick={() => askOperator('Check the Main PC build runtime. If it is installed, capture it for the saved profile and run qualification; reconcile any qualification that needs recovery first.')}>Ask Operator to check it</Button>
  </section>
}
