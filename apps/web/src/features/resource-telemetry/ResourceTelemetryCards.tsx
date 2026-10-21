import { InfoHint } from '../../shared/ui/InfoHint'
import { telemetrySelectorKey, type TelemetryReadResult, type TelemetrySample, type TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import { useResourceTelemetryQuery, type ReceivedTelemetry } from '../../shared/api/resourceTelemetry'
import { Alert, Badge, Card, CardBody, CardHeader, MetricCard } from '../../shared/ui/nocturne'
import { capturedMetricView, coverageView, formatDuration, isCurrent, metricView, reasonLabels, sampleClock, shortId, type MetricView } from './telemetryView'
import { useMonotonicElapsed } from './useMonotonicElapsed'
import './resourceTelemetry.css'

/** Facts supplied by the W08 placement props; the mount decides which phase it truly has. */
export interface TelemetryComputerContext {
  /** configured: next Run only; accepted: dispatched/admitted; observed: execution actually ran there. */
  phase: 'configured' | 'accepted' | 'observed'
  computerName: string
  /** Stable computer id (device id, or main id for the main computer). */
  computerId: string
  /** Inspectable accepted placement identity, e.g. binding hash; shown verbatim in a disclosure. */
  acceptedIdentity?: string
}

const phaseLabel = { configured: 'Configured for next Run', accepted: 'Accepted on', observed: 'Execution observed on' } as const

export function ComputerContextCard({ context, nowTitle }: { context: TelemetryComputerContext; nowTitle?: string }) {
  return <Card className="rt-card" aria-label="Computer context">
    <CardBody>
      <p className="n-eyebrow">{phaseLabel[context.phase]}</p>
      <h4 className="rt-computer">{context.computerName} <code title={context.computerId}>{shortId(context.computerId)}</code></h4>
      {context.acceptedIdentity && <details className="rt-identity"><summary>Accepted identity</summary><code>{context.acceptedIdentity}</code></details>}
      {nowTitle && <p className="rt-note">{nowTitle}</p>}
    </CardBody>
  </Card>
}

function MetricBlock({ view }: { view: MetricView }) {
  return <section className="rt-metric" data-status={view.status} aria-label={`${view.label} ${view.statusLabel}`}>
    <MetricCard label={view.label} value={view.headline ?? '—'} note={view.headline ? view.headlineNote ?? undefined : view.reason ?? undefined} tone={view.tone} />
    <div className="rt-meta"><Badge tone={view.tone}>{view.statusLabel}</Badge>
      {view.source && <span>Source: {view.source}</span>}{view.details.map(detail => <span key={detail}>{detail}</span>)}</div>
  </section>
}

function IdentityDisclosure({ sample }: { sample: TelemetrySample }) {
  const host = sample.identity.host
  return <details className="rt-identity"><summary>Reading identity</summary><dl>
    <dt>Device</dt><dd title={host.deviceId}>{shortId(host.deviceId)}</dd>
    <dt>Installation</dt><dd>{host.applicationInstallationId}</dd>
    <dt>Boot</dt><dd title={host.bootId}>{shortId(host.bootId)}</dd>
    <dt>Runtime epoch</dt><dd>{host.runtimeEpoch}</dd>
    <dt>Collector</dt><dd>{host.collectorGeneration}</dd>
    <dt>Connection generation</dt><dd>{host.connectionGeneration ?? 'main-local'}</dd>
    <dt>Sequence</dt><dd>{sample.sequence}</dd>
  </dl></details>
}

function Freshness({ sample, elapsedMs }: { sample: TelemetrySample; elapsedMs: number }) {
  const clock = sampleClock(sample, elapsedMs)
  return <p className="rt-note">Sampled {new Date(sample.collectedAtUnixMs).toISOString()} · age ≤ {formatDuration(clock.ageMs)} · {clock.freshRemainingMs > 0
    ? `server freshness deadline in ${formatDuration(clock.freshRemainingMs)}` : `server freshness deadline passed ${formatDuration(-clock.freshRemainingMs)} ago`}</p>
}

function SampleBody({ sample, elapsedMs }: { sample: TelemetrySample; elapsedMs: number }) {
  const coverage = coverageView(sample)
  const current = isCurrent(sample, elapsedMs)
  return <>
    <div className="rt-badges">
      <Badge tone={sample.presence === 'online' ? 'success' : 'warning'}>{sample.presence === 'online' ? 'Worker online' : 'Worker offline'}</Badge>
      {!current && sample.presence === 'offline' ? <InfoHint label="Worker offline">Offline is worker presence, not zero use or a finished execution.</InfoHint> : null}
      {sample.ownershipState !== 'active' && <Badge tone="neutral">{sample.ownershipState === 'closure-unconfirmed' ? 'Closure unconfirmed' : sample.ownershipState === 'ended' ? 'Execution ended' : 'Execution closed'}</Badge>}
      {coverage.shared && <Badge tone="info">Shared</Badge>}
      {coverage.partial && <Badge tone="warning">Partial</Badge>}
    </div>
    {coverage.reasons.length > 0 && <p className="rt-note">{coverage.reasons.join(' · ')}</p>}
    <div className="rt-metrics"><MetricBlock view={metricView('CPU', sample, elapsedMs)} /><MetricBlock view={metricView('RAM', sample, elapsedMs)} /></div>
    <Freshness sample={sample} elapsedMs={elapsedMs} />
    <IdentityDisclosure sample={sample} />
  </>
}

const hasCapturedValues = (sample: TelemetrySample) => sample.cpu.state === 'fresh' || sample.memory.state === 'fresh'

/** An explicitly noncurrent earlier reading; never shown as current values. */
function LastKnown({ sample, historical = false }: { sample: TelemetrySample; historical?: boolean }) {
  const cpuView = capturedMetricView('CPU', sample), ramView = capturedMetricView('RAM', sample)
  if (!cpuView && !ramView) return null
  const coverage = coverageView(sample)
  return <section className="rt-last-known" aria-label="Last known">
    <p className="n-eyebrow">{historical ? 'Historical capture' : 'Last known'} · not current</p>
    {(coverage.shared || coverage.partial) && <div className="rt-badges">{coverage.shared && <Badge tone="info">Shared</Badge>}{coverage.partial && <Badge tone="warning">Partial</Badge>}</div>}
    {coverage.reasons.length > 0 && <p className="rt-note">{coverage.reasons.join(' · ')}</p>}
    <p className="rt-note">Captured {new Date(sample.collectedAtUnixMs).toISOString()} · {cpuView ? `CPU ${cpuView.headline} ${cpuView.headlineNote} (${cpuView.source})` : 'CPU not captured'} · {ramView ? `RAM ${ramView.headline} (${ramView.source})` : 'RAM not captured'}</p>
    <p className="rt-note">{[...(cpuView?.details ?? []), ...(ramView?.details ?? [])].join(' · ')}</p>
  </section>
}

export interface ResourceTelemetryPanelProps {
  scope: 'computer' | 'owned'
  title: string
  received: ReceivedTelemetry | undefined
  pending?: boolean
  error?: boolean
  /** Monotonic ms since `received` arrived. */
  elapsedMs: number
}

const scopeNote = { computer: 'Whole computer — not any one Agent’s usage.', owned: 'Only processes owned by this execution — not the whole computer.' } as const

export function ResourceTelemetryPanel({ scope, title, received, pending, error, elapsedMs }: ResourceTelemetryPanelProps) {
  const result: TelemetryReadResult | undefined = received?.result
  const displayElapsedMs = Math.max(0, elapsedMs) + (received?.requestDurationMs ?? 0)
  return <Card className="rt-card" data-scope={scope} role="region" aria-label={title}>
    <CardHeader eyebrow={scope === 'computer' ? 'Whole computer' : 'This execution’s owned processes'} title={title} action={<><InfoHint label={title}>{scopeNote[scope]}</InfoHint>
      <InfoHint label="Resource usage">Local processes only; cloud model inference is not measured.</InfoHint></>} />
    <CardBody>
      {error && <Alert title="Telemetry could not be refreshed" tone="warning" live>Showing only what the server’s freshness deadline still allows.</Alert>}
      {!result && !error && (pending ? <p className="rt-note" role="status">Waiting for the first reading…</p> : <p className="rt-note">No telemetry selection.</p>)}
      {result?.kind === 'denied' && <Alert title="Access denied" tone="danger" live>This session may not read this telemetry. No values are retained.</Alert>}
      {result?.kind === 'no-sample' && <Alert title="No reading" tone="info">{reasonLabels[result.reason]}</Alert>}
      {result?.kind === 'sample' && <>
        <SampleBody sample={result.sample} elapsedMs={displayElapsedMs} />
        {!isCurrent(result.sample, displayElapsedMs) && result.lastKnown && <LastKnown sample={result.lastKnown} />}
      </>}
    </CardBody>
  </Card>
}

function LiveTelemetryPanel({ selector, title }: { selector: TelemetrySelector; title: string }) {
  const query = useResourceTelemetryQuery(selector)
  const elapsedMs = useMonotonicElapsed(query.data?.receivedMonoMs)
  return <ResourceTelemetryPanel scope={selector.scope} title={title} received={query.data} pending={query.isPending} error={query.isError} elapsedMs={elapsedMs} />
}

export interface ScopedResourceTelemetryProps {
  context: TelemetryComputerContext
  /** Exact selector from accepted/observed placement facts; omit when no such fact exists. */
  computerSelector?: Extract<TelemetrySelector, { scope: 'computer' }>
  ownedSelector?: Extract<TelemetrySelector, { scope: 'owned' }>
  /** historical: reviewing a past Run — computer reading is labeled "Computer now"; owned values come only from `capturedOwned`. */
  mode?: 'live' | 'historical'
  capturedOwned?: TelemetryReadResult
}
function HistoricalTelemetry({ result, selector }: { result: TelemetryReadResult | undefined; selector: ScopedResourceTelemetryProps['ownedSelector'] }) {
  if (result?.kind === 'denied') return <Alert title="Access denied" tone="danger">This session may not read this execution’s historical telemetry. No values are retained.</Alert>
  if (result?.kind === 'no-sample' && result.selector.scope === 'owned') return <Alert title="Historical metrics unavailable" tone="neutral">{reasonLabels[result.reason]}</Alert>
  if (!result || result.kind !== 'sample' || result.sample.selector.scope !== 'owned'
    || selector && result.sample.selectorKey !== telemetrySelectorKey(selector))
    return <Alert title="Historical metrics unavailable" tone="neutral">No authorized captured sample exists for this execution.</Alert>
  const sample = hasCapturedValues(result.sample) ? result.sample : result.lastKnown?.selector.scope === 'owned'
    && result.lastKnown.selectorKey === result.sample.selectorKey && hasCapturedValues(result.lastKnown) ? result.lastKnown : null
  if (sample) return <Card className="rt-card" role="region" aria-label="Captured execution metrics"><CardBody><LastKnown sample={sample} historical /></CardBody></Card>
  const reasons = [...new Set([...(result.sample.cpu.state !== 'fresh' ? [result.sample.cpu.reason] : []),
    ...(result.sample.memory.state !== 'fresh' ? [result.sample.memory.reason] : []), ...result.sample.coverage.reasons])]
  return <Alert title="Historical metrics unavailable" tone="neutral">{reasons.map(reason => reasonLabels[reason]).join(' · ') || 'No authorized captured values remain for this execution.'}</Alert>
}

/** Identity/context first, then whole-computer and owned-process panels. Mount only in an open Info surface. */
export function ScopedResourceTelemetry({ context, computerSelector, ownedSelector, mode = 'live', capturedOwned }: ScopedResourceTelemetryProps) {
  const historical = mode === 'historical'
  return <div className="rt-stack">
    <ComputerContextCard context={context} />
    {computerSelector?.scope === 'computer'
      ? <LiveTelemetryPanel selector={computerSelector} title={historical ? 'Computer now' : 'Computer'} />
      : <Alert title="Computer reading unavailable" tone="neutral">No computer selector was supplied for this placement.</Alert>}
    {historical
      ? <HistoricalTelemetry result={capturedOwned} selector={ownedSelector} />
      : ownedSelector?.scope === 'owned'
        ? <LiveTelemetryPanel selector={ownedSelector} title="Execution" />
        : <Alert title="Execution metrics unavailable" tone="neutral">This node has no accepted or observed execution to measure.</Alert>}
  </div>
}
