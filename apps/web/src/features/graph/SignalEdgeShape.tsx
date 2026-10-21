import { useState, type CSSProperties } from 'react'
import { BaseEdge } from '@xyflow/react'
import type { EdgeSignal, FloatingCurve } from './signalEdge'

/** One fact in flight. `startsAt` is a performance.now() time; it may be in the past or future.
 * `word` replaces the signal's usual word for facts that are not handoffs, such as a CI request. */
export type EdgePulse = { key: string; signal: EdgeSignal; reversed: boolean; startsAt: number; word?: string }

/** What each crossing says on its pulse. */
const PULSE_WORDS: Record<EdgeSignal, string> = { task: 'Handoff', return: 'Next round', approval: 'Approval request', grant: 'Approved', error: 'Rejected' }

/** A comet carrying its word, with a charging wire behind it. The delay is fixed at mount so re-renders never restart it. */
export function PulseFlight({ path, pulse }: { path: string; pulse: EdgePulse }) {
  const [delay] = useState(() => pulse.startsAt - performance.now())
  const word = pulse.word ?? PULSE_WORDS[pulse.signal], width = Math.round(word.length * 7.8 + 24)
  return <g className="n-signal-edge-flight" data-signal={pulse.signal} data-reversed={pulse.reversed || undefined}
    style={{ '--flight-delay': `${Math.round(delay)}ms` } as CSSProperties}>
    <path className="n-signal-edge-charge" d={path} pathLength={1} />
    {[5, 3.4, 2.2].map((radius, index) => <circle key={index} className="n-signal-edge-pulse" data-tail={index || undefined}
      r={radius} style={{ offsetPath: `path('${path}')`, '--tail': `${index * 55}ms` } as CSSProperties} />)}
    <g className="n-signal-edge-tag" style={{ offsetPath: `path('${path}')` }}>
      <rect x={-width / 2} y={-31} width={width} height={20} rx={10} />
      <text textAnchor="middle" y={-17}>{word}</text>
    </g>
  </g>
}

/** SignalEdge: base line, a lasting trace, and pulses for facts crossing it. */
export function SignalEdgeShape({ id, curve, kind = 'execution', signal, pulses, interactionWidth = 24 }: {
  id: string; curve: FloatingCurve; kind?: 'execution' | 'approval'; signal?: EdgeSignal; pulses?: readonly EdgePulse[]
  interactionWidth?: number
}) {
  const flying = pulses?.[pulses.length - 1]?.signal
  return <g className="n-signal-edge" data-kind={kind} data-signal={signal ?? flying} data-flying={flying ? '' : undefined}>
    <BaseEdge id={id} path={curve.path} className="n-signal-edge-base" interactionWidth={interactionWidth} />
    {signal ? <path className="n-signal-edge-trace" d={curve.path} /> : null}
    {pulses?.map((pulse) => <PulseFlight key={pulse.key} path={curve.path} pulse={pulse} />)}
  </g>
}
