import type { ActivityItem } from '@foreman-code/contracts'

export function nativeActivityStatus(value: string | null | undefined):
  Extract<ActivityItem, { kind: 'tool' }>['status'] | undefined {
  switch (value) {
    case 'canceled':
    case 'cancelled':
    case 'interrupted':
      return 'canceled'
    case 'failed':
    case 'declined':
    case 'error':
      return 'failed'
    case 'completed':
    case 'pending':
    case 'unknown':
      return value
    case 'inProgress':
    case 'running':
      return 'running'
    default:
      return undefined
  }
}
