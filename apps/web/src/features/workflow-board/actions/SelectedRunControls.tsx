import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { Button } from '../../../shared/ui/nocturne'
import type { RunActionSelection } from './client'
import { useDisclosure } from './state'
import { SelectedRunStop } from './SelectedRunStop'

export function SelectedRunControls({ scope, visible }: {
  scope: RunActionSelection & Partial<Pick<RepeatGraphScopeV3, 'workflowVersionId'>>
  visible: boolean
}) {
  const [open, setOpen] = useDisclosure()
  return <section aria-label="Selected Run controls" hidden={!visible} inert={!visible}>
    <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? 'Hide Run controls' : 'Run controls · Stop'}
    </Button>
    {open && visible ? <SelectedRunStop scope={scope} /> : null}
  </section>
}
