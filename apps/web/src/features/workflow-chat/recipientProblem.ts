import type { WorkflowChatPostRequest } from '@foreman-code/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import { deliveryAction } from '../conversations/delivery/deliveryAction'
import type { RecipientTargetOption } from './RecipientTargetPicker'
import { sameDeliveryTarget } from './draft'

type Delivery = WorkflowChatPostRequest['deliveries'][number]

export function recipientProblem(selection: Delivery | undefined, result: UseQueryResult<RecipientTargetOption[]>) {
  if (result.isPending) return 'Loading targets…'
  if (result.isError) return 'Could not load targets.'
  if (!result.data?.length) return 'No available target.'
  if (!selection) return 'Choose a target.'
  const option = result.data.find(item => sameDeliveryTarget(item.target, selection.target))
  if (!option) return 'The selected target is no longer available. Choose a target explicitly.'
  if (selection.expectedNativeTurnId !== option.presentation.nativeTurnId) {
    return 'Draft targets the previous turn. Refresh this target before sending.'
  }
  return deliveryAction(option.presentation, selection.intent).reason
}

