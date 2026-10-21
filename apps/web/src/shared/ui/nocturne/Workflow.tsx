import type { MouseEvent, ReactNode } from 'react'
import { Badge, StatusBadge, Progress, Alert } from './Feedback'
import { Button } from './Button'
import { Icon, type IconName } from './Icon'
import { cx, type Tone } from './utils'

/** Visual activity is intentionally not an API RunStatus. Map shared contracts in the feature layer. */
export interface WorkflowNodeCardProps {
  title: string; subtitle: string; statusLabel: string; tone?: Tone; icon?: IconName; selected?: boolean
  working?: boolean; disabled?: boolean; progress?: number; detail?: string; meta?: string
  ariaLabel?: string; onSelect?: (event: MouseEvent<HTMLButtonElement>) => void; className?: string
  /** Harness identity (codex, claude, other); drawn as the node's rim color, never as state. */
  harness?: string
}
export function WorkflowNodeCard({ title, subtitle, statusLabel, tone = 'neutral', icon = 'bot', selected, working, disabled, progress, detail, meta, ariaLabel, onSelect, className, harness }: WorkflowNodeCardProps) {
  const content = <><div className="n-node-top"><span className="n-node-icon"><Icon name={icon} size={20} /></span><div><strong>{title}</strong><small>{subtitle}</small></div><span className="n-node-marker" aria-hidden="true"><Icon name={working ? 'spark' : tone === 'success' ? 'check' : tone === 'warning' ? 'clock' : 'more'} size={16} /></span></div>
    {detail && <p className="n-node-detail">{detail}</p>}<div className="n-node-bottom"><StatusBadge label={statusLabel} tone={tone} busy={working} />{meta && <span className="n-mono">{meta}</span>}</div>
    {progress !== undefined && <Progress label={`${title} progress`} value={progress} tone={tone} showValue={false} />}
  </>
  return onSelect ? <button type="button" className={cx('n-node', selected && 'n-node--selected', className)} data-tone={tone} data-working={working || undefined} data-harness={harness}
    aria-pressed={selected} aria-label={ariaLabel ?? `${title}: ${statusLabel}`} disabled={disabled} onClick={onSelect}>{content}</button>
    : <div className={cx('n-node', selected && 'n-node--selected', className)} data-tone={tone} data-working={working || undefined} data-harness={harness}>{content}</div>
}

export interface ApprovalChoice { id: string; label: string; description?: string; destructive?: boolean; disabled?: boolean }
export function ApprovalCard({ title, description, scope, context, choices, onChoose, pending = false, error, canRespond = false, resolvedLabel, resolvedTone = 'neutral', unavailableReason }:
  { title: string; description: string; scope: string; context?: ReactNode; choices: readonly ApprovalChoice[]; onChoose: (id: string) => void; pending?: boolean; error?: string; canRespond?: boolean; resolvedLabel?: string; resolvedTone?: Tone; unavailableReason?: string }) {
  return <section className="n-approval"><header><span className="n-approval-icon"><Icon name="shield" size={21} /></span><div><p className="n-eyebrow">{resolvedLabel ? 'Request resolved' : 'Decision required'}</p><h3>{title}</h3></div><Badge tone={resolvedLabel ? resolvedTone : 'warning'}>{resolvedLabel ?? 'Waiting'}</Badge></header>
    <p>{description}</p><div className="n-scope"><Icon name="lock" size={14} /><span>{scope}</span></div>{context}
    {!canRespond && !resolvedLabel && <p className="n-field-hint">{unavailableReason ?? 'You do not have permission to respond to this request.'}</p>}
    {error && <Alert title="Response not delivered" tone="danger" live>{error} Your decision has not been confirmed.</Alert>}
    {!resolvedLabel && <div className="n-approval-choices">{choices.map((choice) => <div key={choice.id}><Button variant={choice.destructive ? 'danger' : 'secondary'}
      disabled={!canRespond || pending || choice.disabled} loading={pending} onClick={() => onChoose(choice.id)}>{choice.label}</Button>{choice.description && <small>{choice.description}</small>}</div>)}</div>}
  </section>
}

export function RunSummary({ title, status, tone, metadata, progress }: { title: string; status: string; tone?: Tone; metadata: readonly { label: string; value: string }[]; progress?: number }) {
  return <div className="n-run-summary"><div className="n-between"><h3>{title}</h3><StatusBadge label={status} tone={tone} /></div><dl>{metadata.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    {progress !== undefined && <Progress label="Run progress" value={progress} />}</div>
}

/** No synthetic pause/resume API. A control exists only when its authorized handler is provided. */
export function RunControls({ onStart, onCancel, pending, disabled, disabledReason }: { onStart?: () => void; onCancel?: () => void; pending?: boolean; disabled?: boolean; disabledReason?: string }) {
  return <div className="n-stack"><div className="n-actions">{onStart && <Button variant="primary" leading={<Icon name="play" size={15} />} disabled={disabled} loading={pending} onClick={onStart}>Run workflow</Button>}
    {onCancel && <Button variant="danger" leading={<Icon name="stop" size={15} />} disabled={disabled} loading={pending} onClick={onCancel}>Cancel run</Button>}</div>{disabledReason && <span className="n-field-hint">{disabledReason}</span>}</div>
}
