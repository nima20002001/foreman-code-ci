import type { ApprovalResponseOption } from '@foreman-code/contracts'

const scopeLabels: Record<ApprovalResponseOption['persistence'], string> = {
  request: 'This request only.',
  turn: 'This turn.',
  session: 'This native session.',
  provider_instance: 'This provider instance, including other sessions.',
  project: 'This project beyond the current request.',
  persistent_config: 'Persistent native configuration; affects future requests.',
}

/** Never let a provider label/summary hide the structured scope metadata. */
export function approvalOptionScope(option: ApprovalResponseOption): string {
  return `Scope: ${scopeLabels[option.persistence]}`
    + (option.mutatesPersistentPolicy ? ' Changes persistent native policy beyond this request.' : '')
    + (option.affectsOtherPendingRequests ? ' Also affects other pending requests.' : '')
    + (option.interruptsCurrentTurn ? ' Interrupts the current turn.' : '')
}
