import { useId, type CSSProperties, type ReactNode } from 'react'
import { Button, IconButton } from './Button'
import { Icon } from './Icon'
import { Badge, StatusBadge, Progress, EmptyState, Alert } from './Feedback'
import { Select, Slider, Switch } from './Fields'
import { WorkflowNodeCard, type WorkflowNodeCardProps } from './Workflow'
import { frameAt } from './advancedUtils'
import { clamp, type Tone } from './utils'

/** View projections only. Map real event/status contracts in the existing feature adapter. */
export interface ExecutionNode extends WorkflowNodeCardProps { id: string; x: number; y: number }
export interface ExecutionConnection { id: string; from: string; to: string; label: string; detail?: string; state: 'idle' | 'active' | 'complete' | 'blocked' | 'failed' }
export interface ExecutionEvent { id: string; title: string; description?: string; time: string; dateTime?: string; agent?: string; tone?: Tone; frame?: number }
export interface ExecutionMapProps {
  nodes: readonly ExecutionNode[]; connections: readonly ExecutionConnection[]; selectedId?: string
  onSelect: (id: string) => void; layout?: 'graph' | 'list'; animate?: boolean; zoom?: number
  onInspectConnection?: (id: string) => void; empty?: ReactNode
}
function edgePath(from: ExecutionNode, to: ExecutionNode) {
  if (Math.abs(to.x - from.x) < 16 && to.y > from.y) {
    const x = from.x + 104
    return `M${x},${from.y + 180} L${x},${to.y}`
  }
  const leftToRight = to.x >= from.x
  const startX = from.x + (leftToRight ? 208 : 0), endX = to.x + (leftToRight ? 0 : 208)
  const startY = from.y + 67, endY = to.y + 67
  const bend = Math.max(32, Math.abs(endX - startX) * .5)
  return `M${startX},${startY} C${startX + (leftToRight ? bend : -bend)},${startY} ${endX + (leftToRight ? -bend : bend)},${endY} ${endX},${endY}`
}
export function FlowConnection({ path, state, animate, id }: { path: string; state: ExecutionConnection['state']; animate?: boolean; id?: string }) {
  return <g className="n-flow-connection" data-state={state} data-motion={animate ? 'on' : 'off'} id={id}>
    <path className="n-flow-base" d={path} />{state === 'active' && <><path className="n-flow-trace" pathLength="100" d={path} />
      <circle r="3.5" className="n-flow-packet" style={{ offsetPath: `path('${path}')` } as CSSProperties} /></>}
  </g>
}
export function ExecutionMap({ nodes, connections, selectedId, onSelect, layout = 'graph', animate = false, zoom = 100, onInspectConnection, empty }: ExecutionMapProps) {
  const id = useId()
  const safeNodes = nodes.filter(node => Number.isFinite(node.x) && Number.isFinite(node.y) && node.x >= 0 && node.y >= 0)
  const scale = clamp(zoom, 50, 150) / 100
  const width = Math.max(800, ...safeNodes.map(node => node.x + 234))
  const height = Math.max(452, ...safeNodes.map(node => node.y + 188))
  const byId = new Map(safeNodes.map(node => [node.id, node]))
  const edges = connections.filter(edge => byId.has(edge.from) && byId.has(edge.to))
  if (!nodes.length) return <>{empty ?? <EmptyState title="No agents in this workflow" description="Add an agent to begin building the workflow." />}</>
  return <div className="n-execution-map" data-motion={animate ? 'on' : 'off'}>
    {layout === 'graph' ? <div className="n-execution-viewport" tabIndex={0} role="region" aria-label="Agent execution map. Scroll to explore or use list view.">
      <div style={{ width: width * scale, height: height * scale }}><div className="n-execution-board" style={{ width, height, transform: `scale(${scale})` }}>
        <svg className="n-flow-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {edges.map((edge, index) => <FlowConnection key={edge.id} id={`${id}-connection-${index}`} path={edgePath(byId.get(edge.from)!, byId.get(edge.to)!)} state={edge.state} animate={animate} />)}
        </svg>{safeNodes.map(node => <div key={node.id} className="n-execution-node" style={{ left: node.x, top: node.y }}>
          <WorkflowNodeCard {...node} selected={selectedId === node.id} onSelect={() => onSelect(node.id)} />
        </div>)}
      </div></div>
    </div> : <div className="n-execution-list">{nodes.map(node => <WorkflowNodeCard key={node.id} {...node} selected={selectedId === node.id} onSelect={() => onSelect(node.id)} />)}</div>}
    <div className="n-connection-legend" aria-label="Agent handoffs">{connections.map(edge => {
      const label = `${byId.get(edge.from)?.title ?? edge.from} → ${byId.get(edge.to)?.title ?? edge.to}: ${edge.label} · ${edge.state}`
      return onInspectConnection ? <button type="button" key={edge.id} data-state={edge.state} onClick={() => onInspectConnection(edge.id)}><span className="n-connection-dot" />{label}</button> :
        <span key={edge.id} data-state={edge.state}><span className="n-connection-dot" />{label}</span>
    })}</div>
  </div>
}
export function ReplayControls({ index, count, playing, onPlayingChange, onSeek, speed = 1, onSpeedChange, disabled = false }:
  { index: number; count: number; playing: boolean; onPlayingChange: (playing: boolean) => void; onSeek: (index: number) => void; speed?: number; onSpeedChange?: (speed: number) => void; disabled?: boolean }) {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  const current = frameAt(index, total)
  const locked = disabled || total === 0
  function seek(next: number) { if (!locked) { onPlayingChange(false); onSeek(frameAt(next, total)) } }
  return <div className="n-replay-controls"><div className="n-replay-buttons">
    <IconButton label="Restart replay" disabled={locked} onClick={() => seek(0)}><Icon name="history" size={16} /></IconButton>
    <IconButton label="Previous event" disabled={locked || current === 0} onClick={() => seek(current - 1)}><Icon name="chevron" className="n-flip" size={16} /></IconButton>
    <Button variant="primary" disabled={locked || total < 2} onClick={() => { if (locked) return; if (!playing && current === total - 1) onSeek(0); onPlayingChange(!playing) }} leading={<Icon name={playing ? 'stop' : 'play'} size={15} />}>{playing ? 'Pause replay' : 'Play replay'}</Button>
    <IconButton label="Next event" disabled={locked || current >= total - 1} onClick={() => seek(current + 1)}><Icon name="chevron" size={16} /></IconButton></div>
    <Slider label="Replay position" value={current} min={0} max={Math.max(0, total - 1)} onValueChange={seek} disabled={locked} format={value => total ? `${value + 1} / ${total}` : 'No events'} />
    {onSpeedChange && <Select label="Replay speed" value={String([.5, 1, 2].includes(speed) ? speed : 1)} disabled={locked} options={[{ value: '.5', label: '0.5×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }].map(option => ({ ...option, value: option.value === '.5' ? '0.5' : option.value }))}
      onChange={event => onSpeedChange(Number(event.currentTarget.value))} />}
    <p className="n-replay-note"><Icon name="info" size={12} />Replay changes this view, not the running agents.</p>
  </div>
}
export function ExecutionTimeline({ events, selectedId, onSelect, label = 'Execution events' }:
  { events: readonly ExecutionEvent[]; selectedId?: string; onSelect?: (id: string) => void; label?: string }) {
  return <ol className="n-execution-timeline" aria-label={label}>{events.map(event => <li key={event.id} data-tone={event.tone ?? 'neutral'} data-selected={selectedId === event.id || undefined}>
    <span className="n-event-dot" aria-hidden="true" /><div><div className="n-between"><time dateTime={event.dateTime}>{event.time}</time>{event.agent && <Badge>{event.agent}</Badge>}</div>
      {onSelect ? <button type="button" aria-current={selectedId === event.id ? 'step' : undefined} onClick={() => onSelect(event.id)}>{event.title}</button> : <strong>{event.title}</strong>}
      {event.description && <p>{event.description}</p>}</div>
  </li>)}</ol>
}
export function HandoffCard({ from, to, title, description, state, artifacts, onInspect }: {
  from: string; to: string; title: string; description: string; state: string; artifacts?: readonly string[]; onInspect?: () => void
}) {
  return <section className="n-handoff"><div className="n-between"><p className="n-eyebrow">Agent handoff</p><Badge tone="accent">{state}</Badge></div>
    <div className="n-handoff-route"><span><Icon name="bot" />{from}</span><Icon name="chevron" /><span><Icon name="bot" />{to}</span></div>
    <h3>{title}</h3><p>{description}</p>{artifacts && <ul>{artifacts.map((artifact, index) => <li key={`${artifact}-${index}`}><Icon name="code" size={14} />{artifact}</li>)}</ul>}
    {onInspect && <Button onClick={onInspect} variant="ghost">Inspect payload<Icon name="chevron" size={14} /></Button>}
  </section>
}
export function AgentActivityPanel({ name, status, tone = 'accent', summary, steps, progress, children }: {
  name: string; status: string; tone?: Tone; summary: string; steps: readonly { id: string; label: string; state: 'waiting' | 'active' | 'complete' | 'failed' }[]; progress?: number; children?: ReactNode
}) {
  return <section className="n-agent-activity"><header><span className="n-node-icon"><Icon name="bot" /></span><div><h3>{name}</h3><StatusBadge label={status} tone={tone} /></div></header>
    <p className="n-activity-summary">{summary}</p>{progress !== undefined && <Progress label={`${name} progress`} value={progress} tone={tone} />}
    <ol className="n-agent-steps">{steps.map(step => <li key={step.id} data-state={step.state}><Icon name={step.state === 'complete' ? 'check' : step.state === 'failed' ? 'warning' : step.state === 'active' ? 'spark' : 'clock'} size={15} /><span>{step.label}</span><small>{step.state}</small></li>)}</ol>
    {children}<p className="n-field-hint">Reported actions and results—not private reasoning.</p>
  </section>
}
export function BudgetMeter({ label, used, limit, format = String, hint }: { label: string; used?: number; limit?: number; format?: (value: number) => string; hint?: string }) {
  const known = used !== undefined && Number.isFinite(used) && used >= 0 && limit !== undefined && Number.isFinite(limit) && limit > 0
  const percent = known ? used / limit * 100 : undefined
  return <div className="n-budget-meter"><div className="n-between"><strong>{label}</strong><Badge tone={!known ? 'neutral' : percent! >= 100 ? 'danger' : percent! >= 80 ? 'warning' : 'neutral'}>{known ? `${format(used)} / ${format(limit)}` : 'Not available'}</Badge></div>
    {known && <Progress label={label} value={percent} tone={percent! >= 100 ? 'danger' : percent! >= 80 ? 'warning' : 'accent'} />}{hint && <p className="n-field-hint">{hint}</p>}</div>
}
export function FailureRecovery({ title, description, details, onRetry, onInspect, pending, retryLabel = 'Retry', unavailableReason }:
  { title: string; description: string; details?: ReactNode; onRetry?: () => void; onInspect?: () => void; pending?: boolean; retryLabel?: string; unavailableReason?: string }) {
  return <Alert title={title} tone="danger"><p>{description}</p>{details}<div className="n-actions">
    {onInspect && <Button onClick={onInspect}>Inspect failure</Button>}{onRetry && <Button disabled={Boolean(unavailableReason)} loading={pending} onClick={onRetry}>{retryLabel}</Button>}</div>
    {unavailableReason && <p className="n-field-hint">{unavailableReason}</p>}</Alert>
}
export function MotionControl({ enabled, onEnabledChange, systemReduced = false }: { enabled: boolean; onEnabledChange: (enabled: boolean) => void; systemReduced?: boolean }) {
  return <Switch label="Connection animation" checked={enabled && !systemReduced} disabled={systemReduced} hint={systemReduced ? 'Reduced motion is enabled on this device.' : 'Visual motion only. Agent execution is unchanged.'} onChange={event => onEnabledChange(event.currentTarget.checked)} />
}
