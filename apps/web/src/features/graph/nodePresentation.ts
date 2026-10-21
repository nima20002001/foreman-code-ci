import { RunNodeLiveActivitySchema } from '@foreman-code/contracts'

/** Renderer meaning only; not a lifecycle, transport, or replay protocol. */
export type GraphNodePresentation = {
  state: 'idle' | 'working' | 'waiting' | 'unavailable'
  label: string
  tone: 'neutral' | 'accent' | 'warning'
  working: boolean
  eventId: string
  actionLabel?: string
}

const UNAVAILABLE: GraphNodePresentation = {
  state: 'unavailable', label: 'Activity unavailable', tone: 'neutral', working: false, eventId: '',
}
const IDLE: GraphNodePresentation = {
  state: 'idle', label: 'Idle', tone: 'neutral', working: false, eventId: '',
}

/**
 * Consume only the canonical runtime leaf, never static mapper data or transport
 * state. No scoped fact means unavailable; an unscoped authoring card can be Idle.
 * Unknown values are not idle, failure, success, or a reason to animate.
 */
export function presentGraphNodeRuntime(activity: unknown, unavailable: boolean): GraphNodePresentation {
  if (unavailable) return UNAVAILABLE
  if (activity === undefined) return IDLE
  const parsed = RunNodeLiveActivitySchema.safeParse(activity)
  if (!parsed.success) return UNAVAILABLE
  const node = parsed.data
  switch (node.state) {
    case 'idle': return { ...IDLE, eventId: node.event?.id ?? '' }
    case 'working':
    case 'waiting':
      return {
        state: node.state, label: node.state === 'working' ? 'Working' : 'Waiting',
        tone: node.state === 'working' ? 'accent' : 'warning',
        working: node.state === 'working', eventId: node.event?.id ?? '',
        actionLabel: node.action?.label,
      }
    default: return UNAVAILABLE
  }
}
