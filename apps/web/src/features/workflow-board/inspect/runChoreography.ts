import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepeatGraphCurrentV3, WorkflowRelationship } from '@foreman-code/contracts/wave25'
import type { AgentNodeState, AgentNodeTransition } from '../../../shared/ui/nocturne'
import type { EdgeSignal } from '../../graph/signalEdge'
import { lifecycleView } from '../runFacts'
import { pinnedNodeStates } from './pinnedTopology'

/** Pulse travel time along an edge, and how long a node's arrival animation lasts. Presentation only. */
export const TRAVEL_MS = 1400
export const SETTLE_MS = 1100
const GAP_MS = 180

type RunEdge = Pick<WorkflowRelationship, 'id' | 'kind' | 'source' | 'target'>
export type RunNodeDisplay = { state: AgentNodeState; label: string }
/** One accepted fact that crosses an edge: a handoff, a repeat carry, an approval request or its answer.
 * `fromExecution`/`toExecution` are exact attempts, so causal order survives repeats and retries. */
export type Handoff = { key: string; edgeId: string; signal: EdgeSignal; reversed: boolean; from: string; to: string
  kind: 'binding' | 'ask' | 'answer'; fromExecution: string; toExecution: string }
export type Pulse = Handoff & { startsAt: number }

const IDLE: RunNodeDisplay = { state: 'idle', label: 'Not started' }
const ACTIVE: readonly AgentNodeState[] = ['queued', 'running', 'waiting', 'approved']
const ACTIONS: Partial<Record<string, string>> = {
  reading_file: 'Reading files', writing_file: 'Writing files', creating_folder: 'Creating folders',
  using_tool: 'Using tools', using_app_mcp: 'Using App tools', spawning_subagent: 'Starting a helper',
}

/** Node words from the canonical cut: lifecycle first, then (unless `lifecycleOnly`) the exact current activity. */
export function runNodeDisplays(record: RepeatGraphCurrentV3, lifecycleOnly = false): Map<string, RunNodeDisplay> {
  const views = new Map<string, RunNodeDisplay>()
  for (const [nodeId, fact] of pinnedNodeStates(record)) {
    const [state, label] = lifecycleView(fact.label)
    views.set(nodeId, { state, label })
  }
  const live = !lifecycleOnly && record.state.run.executionState !== 'completed'
  // A waiting requester follows its newest approval: asked, answered, delivered, and resumed by the harness.
  const newest = new Map<string, RepeatGraphCurrentV3['state']['interactions'][number]>()
  for (const interaction of record.state.interactions) {
    const id = interaction.requester.workflowNodeId, other = newest.get(id)
    if (!other || other.status !== 'pending' && (interaction.status === 'pending' || BigInt(interaction.revision) > BigInt(other.revision))) newest.set(id, interaction)
  }
  for (const [id, interaction] of live ? newest : []) {
    if (views.get(id)?.state !== 'waiting') continue
    const rejected = interaction.decision === 'reject' || interaction.decision === 'cancel'
    views.set(id, interaction.status === 'pending' ? { state: 'waiting', label: 'Needs approval' }
      : interaction.status === 'delivered' && interaction.resumeState === 'acknowledged' ? { state: 'running', label: 'Continuing' }
      : interaction.status === 'delivered' ? { state: rejected ? 'waiting' : 'approved', label: 'Resuming' }
      : interaction.status === 'delivery_failed' ? { state: 'waiting', label: 'Answer not delivered' }
      : interaction.status === 'canceled' ? { state: 'waiting', label: 'Waiting' }
      : rejected ? { state: 'waiting', label: 'Rejected' } : { state: 'approved', label: 'Approved' })
  }
  for (const node of record.state.nodes) {
    const { activity } = node, id = node.state.workflowNodeId
    if (!live || activity.status !== 'active' || !activity.action) continue
    if (activity.action === 'reviewing') views.set(id, { state: 'running', label: 'Reviewing' })
    else if (activity.action === 'waiting_approval') views.set(id, { state: 'waiting', label: 'Needs approval' })
    else if (views.get(id)?.state === 'running' && ACTIONS[activity.action]) views.set(id, { state: 'running', label: ACTIONS[activity.action]! })
  }
  return views
}

/** Every edge crossing the cut records, in the direction the fact travelled. */
export function runHandoffs(record: RepeatGraphCurrentV3, edges: readonly RunEdge[]): Handoff[] {
  const handoffs: Handoff[] = []
  for (const binding of record.state.bindings) {
    const from = binding.sender.workflowNodeId, to = binding.recipient.workflowNodeId
    if (binding.kind === 'predecessor') {
      const edge = edges.find((item) => item.id === binding.relationshipId && item.kind === 'execution')
      if (edge) handoffs.push({ key: binding.bindingId, edgeId: edge.id, signal: 'task', reversed: false, from, to, kind: 'binding',
        fromExecution: binding.sender.executionId, toExecution: binding.recipient.executionId })
    } else if (binding.kind === 'carry') {
      // A repeat carry returns along the block's own edge when no back edge is drawn.
      const edge = edges.find((item) => item.kind === 'execution' && item.source === from && item.target === to)
        ?? edges.find((item) => item.kind === 'execution' && item.source === to && item.target === from)
      if (edge) handoffs.push({ key: binding.bindingId, edgeId: edge.id, signal: 'return', reversed: edge.source !== from, from, to, kind: 'binding',
        fromExecution: binding.sender.executionId, toExecution: binding.recipient.executionId })
    }
  }
  for (const interaction of record.state.interactions) {
    const edge = interaction.approvalRelationshipId ? edges.find((item) => item.id === interaction.approvalRelationshipId) : undefined
    if (!edge || !interaction.reviewer) continue
    const requester = interaction.requester.workflowNodeId, reviewer = interaction.reviewer.workflowNodeId
    const asking = interaction.requester.executionId, reviewing = interaction.reviewer.executionId
    handoffs.push({ key: `ask:${interaction.interactionId}`, edgeId: edge.id, signal: 'approval', reversed: edge.source !== requester,
      from: requester, to: reviewer, kind: 'ask', fromExecution: asking, toExecution: reviewing })
    if (interaction.decision && interaction.status !== 'canceled') handoffs.push({ key: `answer:${interaction.interactionId}`, edgeId: edge.id,
      signal: ['reject', 'cancel'].includes(interaction.decision) ? 'error' : 'grant', reversed: edge.source !== reviewer,
      from: reviewer, to: requester, kind: 'answer', fromExecution: reviewing, toExecution: asking })
  }
  return handoffs
}

type Memory = {
  primed: boolean
  /** After the first shown cut, a node with no facts yet was on screen as Not started. */
  displayed: boolean
  starts: Map<string, number>
  handoffs: Map<string, Handoff>
  shown: Map<string, RunNodeDisplay>
  transitions: Map<string, { kind: AgentNodeTransition; at: number }>
  landed: Set<string>
}
export type RunNodeCue = RunNodeDisplay & { transition?: AgentNodeTransition; transitionKey?: number }
export type RunChoreography = {
  nodes: Map<string, RunNodeCue>
  pulses: Map<string, Pulse[]>
}

function transitionFor(before: RunNodeDisplay, after: RunNodeDisplay): AgentNodeTransition | undefined {
  if (after.state === 'running' && before.state !== 'running') return 'ignite'
  if (after.state === 'completed' && before.state !== 'completed') return 'complete'
  if (after.state === 'failed' && before.state !== 'failed') return 'fail'
  if (after.state === 'waiting' && before.state !== 'waiting') return 'wait'
  if (after.state === 'approved' && before.state !== 'approved') return 'grant'
  return undefined
}

/** Which earlier crossings must land before this one may leave. Execution-exact, so it has no cycles. */
function causes(handoff: Handoff, all: Iterable<Handoff>): Handoff[] {
  if (handoff.kind === 'answer') return [...all].filter((other) => other.kind === 'ask' && other.key === `ask:${handoff.key.slice('answer:'.length)}`)
  // A sender acts only once its own input (and, for a handoff, any approval answer) reached that exact execution.
  // A reviewer's handoff never waits for requests it reviews later.
  return [...all].filter((other) => other.toExecution === handoff.fromExecution
    && (handoff.kind === 'binding' ? other.kind !== 'ask' : other.kind === 'binding'))
}

/**
 * Presentation timing over canonical facts. Polls can land several steps at
 * once, so a receiver keeps the words it had before a crossing until the pulse
 * carrying it arrives, and a sender's pulse leaves only after its own input landed.
 * Nothing here changes a fact; it only orders what is already recorded.
 */
export function useRunChoreography(record: RepeatGraphCurrentV3 | undefined, edges: readonly RunEdge[] | undefined): RunChoreography {
  const memory = useRef<Memory>({ primed: false, displayed: false, starts: new Map(), handoffs: new Map(), shown: new Map(), transitions: new Map(), landed: new Set() })
  const [tick, setTick] = useState(0)
  const views = useMemo(() => record ? runNodeDisplays(record) : undefined, [record])
  const lifecycles = useMemo(() => record ? runNodeDisplays(record, true) : undefined, [record])
  const found = useMemo(() => record && edges ? runHandoffs(record, edges) : [], [record, edges])
  const now = performance.now()
  const m = memory.current
  if (views) {
    const known = [...m.handoffs.values(), ...found.filter((handoff) => !m.handoffs.has(handoff.key))]
    let pending = found.filter((handoff) => !m.starts.has(handoff.key))
    while (pending.length) {
      const ready = pending.filter((handoff) => causes(handoff, known).every((cause) => m.starts.has(cause.key)))
      for (const handoff of ready.length ? ready : pending) {
        // History already on screen when the Run opens does not replay, except what is still arriving.
        const replay = m.primed || ACTIVE.includes(views.get(handoff.to)?.state ?? 'idle')
        const after = Math.max(-Infinity, ...causes(handoff, known).map((cause) => (m.starts.get(cause.key) ?? -Infinity) + TRAVEL_MS + GAP_MS))
        m.starts.set(handoff.key, replay ? Math.max(now, after) : -Infinity)
        m.handoffs.set(handoff.key, handoff)
      }
      pending = pending.filter((handoff) => !m.starts.has(handoff.key))
    }
    m.primed = true
  }
  const nodes = new Map<string, RunNodeCue>()
  const pulses = new Map<string, Pulse[]>()
  const next = new Map<string, Pulse>()
  const landing = new Map<string, Handoff>()
  let wake = Infinity
  for (const [key, handoff] of m.handoffs) {
    const startsAt = m.starts.get(key)!, lands = startsAt + TRAVEL_MS
    if (now >= lands) {
      // A pulse that just reached its receiver sets off the bang; history lands silently.
      if (!m.landed.has(key)) { m.landed.add(key); if (startsAt > -Infinity) landing.set(handoff.to, handoff) }
      continue
    }
    wake = Math.min(wake, lands)
    const pulse = { ...handoff, startsAt }
    pulses.set(handoff.edgeId, [...pulses.get(handoff.edgeId) ?? [], pulse])
    if (!next.has(handoff.to) || next.get(handoff.to)!.startsAt > startsAt) next.set(handoff.to, pulse)
  }
  for (const [nodeId, view] of views ?? []) {
    // A receiver shows what it was before the earliest crossing still on its way.
    const incoming = next.get(nodeId), before = m.shown.get(nodeId) ?? (m.displayed ? IDLE : undefined)
    const shown = !incoming ? view
      : incoming.kind === 'answer' ? { state: 'waiting' as const, label: 'Needs approval' }
      : incoming.kind === 'ask' ? lifecycles?.get(nodeId) ?? IDLE
      : before && !ACTIVE.includes(before.state) ? before : IDLE
    const landed = landing.get(nodeId), changed = before && (before.state !== shown.state || before.label !== shown.label)
    const stateful = before && changed ? transitionFor(before, shown) : undefined
    const kind = landed ? landed.signal === 'approval' ? 'ask' : landed.signal === 'grant' ? 'grant' : landed.signal === 'error' ? 'fail'
      : stateful === 'ignite' ? 'ignite' : 'arrive' : stateful
    if (kind) m.transitions.set(nodeId, { kind, at: now })
    m.shown.set(nodeId, shown)
    const transition = m.transitions.get(nodeId)
    if (transition && now < transition.at + SETTLE_MS) wake = Math.min(wake, transition.at + SETTLE_MS)
    nodes.set(nodeId, { ...shown, ...(transition && now < transition.at + SETTLE_MS ? { transition: transition.kind, transitionKey: transition.at } : {}) })
  }
  if (views) m.displayed = true
  useEffect(() => {
    if (wake === Infinity) return
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(16, wake - performance.now() + 16))
    return () => clearTimeout(timer)
  }, [wake, tick])
  return { nodes, pulses }
}
