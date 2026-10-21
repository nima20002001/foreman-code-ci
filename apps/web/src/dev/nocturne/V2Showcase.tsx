import { useEffect, useState } from 'react'
import {
  Icon, Button, IconButton, Badge, Card, CardHeader, CardBody, PageHeader, Tabs, SegmentedControl, Alert,
  TextField, Textarea, Select, Switch, Dialog, BottomSheet, Drawer, ConfirmDialog,
  SettingsDialog, WizardDialog, ReviewChangesDialog, ResourcePickerDialog, ProgressDialog,
  ActionMenu, ExecutionMap, ReplayControls, ExecutionTimeline, AgentActivityPanel, HandoffCard,
  BudgetMeter, MotionControl, FailureRecovery, PermissionMatrix, NotificationCenter, MultiSelect,
  FilterChips, FileDropzone, KeyboardShortcuts, ToolCallCard, ApprovalCard, CodeBlock,
  useToast, useReplay, useReducedMotion, type DialogProps,
} from '../../shared/ui/nocturne'
import { initialSettings, settingsForAgent, settingsFields, replayNodes, replayConnections, replayEvents, sampleNotifications } from './v2Fixtures'

export function ExecutionLab() {
  const [index, setIndex] = useState(2)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [selected, setSelected] = useState('builder')
  const [layout, setLayout] = useState('graph')
  const [zoom, setZoom] = useState(100)
  const [motion, setMotion] = useState(true)
  const [inspector, setInspector] = useState('activity')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [handoff, setHandoff] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [drafts, setDrafts] = useState(() => Object.fromEntries(['planner', 'builder', 'tester', 'reviewer'].map(id => [id, settingsForAgent(id)])))
  const [savedByAgent, setSavedByAgent] = useState(() => Object.fromEntries(['planner', 'builder', 'tester', 'reviewer'].map(id => [id, settingsForAgent(id)])))
  const values = drafts[selected]
  const saved = savedByAgent[selected]
  const reduced = useReducedMotion()
  const { notify } = useToast()
  useReplay({ index, count: replayEvents.length, playing, speed, onSeek: setIndex, onPlayingChange: setPlaying })
  useEffect(() => { setDenied(false); if (index === 3 || index === 5) setPlaying(false) }, [index])
  const nodes = replayNodes(index)
  const connections = replayConnections(index)
  const node = nodes.find(item => item.id === selected) ?? nodes[1]
  const queued = node.statusLabel === 'Queued' || node.statusLabel === 'Waiting'
  const complete = node.statusLabel === 'Complete'
  const blocked = node.statusLabel === 'Approval needed'
  const edge = connections.find(item => item.id === handoff)
  const stage = replayEvents[index]
  const seek = (next: number) => { setIndex(next); setDenied(false) }
  return <div className="v2-lab" data-v2-view="lab">
    <div className="v2-section-kicker"><span className="v2-live-dot" />INTERACTION SYSTEM <span>/</span> NOCTURNE 2.0</div>
    <PageHeader title="See the work happen." description="Every handoff has context. Every wait has a reason. Every decision stays yours."
      actions={<><ActionMenu label="Workflow actions" triggerLabel="Workflow actions" icon="workflow" items={[
        { id: 'configure', label: 'Configure agent…', icon: 'settings', onSelect: () => setSettingsOpen(true) },
        { id: 'views', label: 'View', kind: 'submenu', items: [{ id: 'graph', label: 'Graph view', kind: 'radio', checked: layout === 'graph', onSelect: () => setLayout('graph') }, { id: 'list', label: 'List view', kind: 'radio', checked: layout === 'list', onSelect: () => setLayout('list') }] },
        { id: 'motion', label: 'Connection motion', kind: 'checkbox', checked: motion, disabled: reduced, onCheckedChange: setMotion },
        { id: 'sep', kind: 'separator', label: 'Run boundaries' },
        { id: 'cancel', label: 'Cancel real run', disabled: true, description: 'No backend is connected in this preview.', onSelect: () => {} },
      ]} /><Button variant="primary" leading={<Icon name="play" size={15} />} onClick={() => { seek(0); setPlaying(true) }}>Watch the handoff</Button></>} />
    <div className="v2-run-strip"><div><Badge tone="accent">Sample replay</Badge><strong>Website workflow</strong><span className="n-mono">#1048</span></div>
      <div><span><Icon name="bot" size={14} />4 agents</span><span><Icon name="clock" size={14} />{stage.time} / 02:04</span><Badge tone={stage.tone}>{index === 3 ? 'Decision required' : index === 5 ? 'Needs attention' : index === 8 ? 'Complete' : 'In progress'}</Badge></div></div>
    <div className="v2-lab-grid"><div className="v2-main-column"><Card className="v2-canvas-card"><div className="v2-canvas-toolbar"><div><Icon name="workflow" size={17} /><strong>Execution map</strong></div>
      <SegmentedControl label="Execution view" value={layout} onValueChange={setLayout} options={[{ value: 'graph', label: 'Graph' }, { value: 'list', label: 'List' }]} />
      <div className="n-actions"><IconButton size="sm" label="Zoom out execution" disabled={zoom <= 70} onClick={() => setZoom(value => Math.max(70, value - 10))}><Icon name="minus" size={14} /></IconButton><span className="n-mono v2-zoom">{zoom}%</span><IconButton size="sm" label="Zoom in execution" disabled={zoom >= 130} onClick={() => setZoom(value => Math.min(130, value + 10))}><Icon name="plus" size={14} /></IconButton></div></div>
      <ExecutionMap nodes={nodes} connections={connections} selectedId={selected} onSelect={setSelected} layout={layout === 'list' ? 'list' : 'graph'} animate={motion && !reduced && playing} zoom={zoom} onInspectConnection={setHandoff} />
      <ReplayControls index={index} count={replayEvents.length} playing={playing} onPlayingChange={setPlaying} onSeek={seek} speed={speed} onSpeedChange={setSpeed} />
    </Card>
    <div className="v2-now" role="status"><span className="v2-now-icon"><Icon name={stage.tone === 'danger' ? 'warning' : stage.tone === 'warning' ? 'shield' : 'spark'} size={20} /></span><div><span className="n-eyebrow">What is happening</span><strong>{denied ? 'Request denied in this preview' : stage.title}</strong><p>{denied ? 'No command was executed. The sample stays at this decision.' : stage.description}</p></div><Badge>{index + 1} / {replayEvents.length}</Badge></div>
    {index === 3 && <ApprovalCard title="Run the project test suite" description="Builder wants to verify the patch. The requested scope is explicit and limited." scope="This command · this run only" canRespond resolvedLabel={denied ? 'Denied' : undefined}
      context={<CodeBlock label="Requested command" code="corepack pnpm test" copy={false} />} choices={[{ id: 'deny', label: 'Deny' }, { id: 'allow', label: 'Allow once' }]}
      onChoose={id => { if (id === 'allow') { seek(4); notify({ title: 'Sample approval recorded', description: 'No command was executed.' }) } else setDenied(true) }} />}
    {index === 5 && <FailureRecovery title="The first verification attempt failed" description="A sample assertion did not pass. The original failure stays visible in the event history."
      onRetry={() => { seek(6); notify({ title: 'Showing the retry step', description: 'This advances the replay only.' }) }} retryLabel="Replay the retry" />}
    <div className="v2-two-cards"><HandoffCard from="Planner" to="Builder" title="A brief, not a black box." description="The next agent receives the task, acceptance checks, and allowed scope." state="Delivered" artifacts={['task-brief.md', 'acceptance-checklist']} onInspect={() => setHandoff('brief')} />
      <Card><CardHeader title="Visible limits" description="Sample measurements · not billing data" /><CardBody><div className="n-stack"><BudgetMeter label="Context window" used={8400} limit={32000} format={value => `${(value / 1000).toFixed(1)}k`} /><BudgetMeter label="Execution time" used={Number(stage.time.split(':')[0]) * 60 + Number(stage.time.split(':')[1])} limit={600} format={value => `${value}s`} /></div></CardBody></Card></div>
    </div><aside className="v2-inspector"><div className="v2-inspector-head"><span className="n-eyebrow">Selected agent</span><ActionMenu label="Selected agent actions" items={[{ id: 'settings', label: 'Advanced settings…', icon: 'settings', onSelect: () => setSettingsOpen(true) }, { id: 'inspect', label: 'Inspect permissions', icon: 'shield', onSelect: () => setInspector('permissions') }]} /></div>
      <Tabs label="Execution inspector" value={inspector} onValueChange={setInspector} items={[
        { value: 'activity', label: 'Activity', content: <div className="n-stack"><AgentActivityPanel name={node.title} status={node.statusLabel} tone={node.tone} summary={node.detail ?? ''} progress={node.progress}
          steps={[{ id: 'context', label: 'Read task context', state: queued ? 'waiting' : 'complete' }, { id: 'task', label: selected === 'reviewer' ? 'Inspect the patch' : 'Work within scope', state: complete ? 'complete' : node.statusLabel === 'Failed' ? 'failed' : queued || blocked ? 'waiting' : 'active' }, { id: 'result', label: 'Report the result', state: complete ? 'complete' : 'waiting' }]}>
          {!queued && <ToolCallCard title="Workspace inspection" status="Complete" tone="success" summary="Read the repository instructions"><CodeBlock label="Reported output" code="AGENTS.md read. Workspace scope confirmed.\nNo permission changes requested." copy={false} /></ToolCallCard>}
        </AgentActivityPanel><Button leading={<Icon name="settings" size={15} />} onClick={() => setSettingsOpen(true)}>Advanced agent settings</Button><MotionControl enabled={motion} onEnabledChange={setMotion} systemReduced={reduced} /></div> },
        { value: 'events', label: 'Events', content: <ExecutionTimeline events={replayEvents} selectedId={stage.id} onSelect={id => { setPlaying(false); seek(replayEvents.findIndex(event => event.id === id)) }} /> },
        { value: 'permissions', label: 'Access', content: <PermissionMatrix rows={[{ id: 'read', resource: 'Read workspace', scope: 'This workspace', allowed: true }, { id: 'write', resource: 'Write files', scope: 'This workspace', allowed: selected !== 'reviewer', reason: selected === 'reviewer' ? 'Reviewer stays read-only.' : undefined }, { id: 'command', resource: 'Restricted command', scope: 'Explicit approval', allowed: false }]} /> },
      ]} />
    </aside></div>
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} title={`Configure ${node.title}`} description="Sample capability-driven settings. No production configuration is changed." fields={settingsFields.map(field => ({ ...field, overridden: settingsForAgent(selected)[field.id] !== values[field.id], ...(selected === 'reviewer' && field.id === 'sandbox' ? { readOnly: true, unavailableReason: 'Reviewer remains read-only in this sample.' } : {}) }))} values={values}
      onResetField={id => setDrafts(previous => ({ ...previous, [selected]: { ...previous[selected], [id]: settingsForAgent(selected)[id] } }))}
      onValueChange={(id, value) => setDrafts(previous => ({ ...previous, [selected]: { ...previous[selected], [id]: value } }))} dirty={JSON.stringify(values) !== JSON.stringify(saved)}
      onSave={() => { setSavedByAgent(previous => ({ ...previous, [selected]: { ...values } })); notify({ title: 'Preview settings saved', description: 'Only this local example was updated.', tone: 'success' }) }} />
    <Dialog open={Boolean(edge)} onOpenChange={open => { if (!open) setHandoff(null) }} title="Inspect agent handoff" description="A readable projection of the shared payload, not private reasoning.">
      {edge && <HandoffCard from={nodes.find(item => item.id === edge.from)?.title ?? ''} to={nodes.find(item => item.id === edge.to)?.title ?? ''} title={edge.label} description={edge.detail ?? ''} state={edge.state} artifacts={['Task summary', 'Artifact references', 'Verification result']} />}
    </Dialog>
  </div>
}

type DemoModal = 'settings' | 'wizard' | 'review' | 'picker' | 'progress' | 'sheet' | 'fullscreen' | 'confirm' | 'inspector' | 'shortcuts' | 'playground' | null
const modalCards: { id: Exclude<DemoModal, null>; icon: 'settings' | 'workflow' | 'code' | 'folder' | 'clock' | 'menu' | 'maximize' | 'shield' | 'bot' | 'command'; title: string; description: string; tag: string }[] = [
  { id: 'settings', icon: 'settings', title: 'Advanced configuration', description: 'Search, sections, inheritance, errors, and guarded drafts.', tag: 'Configuration' },
  { id: 'wizard', icon: 'workflow', title: 'Guided agent setup', description: 'Task → runtime → review, with validation at each step.', tag: 'Multi-step' },
  { id: 'review', icon: 'code', title: 'Review changes', description: 'Compare before and after before applying a configuration.', tag: 'Diff' },
  { id: 'picker', icon: 'folder', title: 'Choose a resource', description: 'Search workspaces or artifacts without losing selection.', tag: 'Picker' },
  { id: 'inspector', icon: 'bot', title: 'Agent inspector', description: 'Keep the workflow in view while inspecting the details.', tag: 'Side panel' },
  { id: 'sheet', icon: 'menu', title: 'Quick actions', description: 'A bottom sheet for focused, mobile-friendly decisions.', tag: 'Bottom sheet' },
  { id: 'progress', icon: 'clock', title: 'Operation progress', description: 'Visible steps; hide the view without cancelling the work.', tag: 'Progress' },
  { id: 'confirm', icon: 'shield', title: 'Destructive confirmation', description: 'Exact-name confirmation, with a safe default action.', tag: 'Guardrail' },
  { id: 'fullscreen', icon: 'maximize', title: 'Artifact workspace', description: 'A full-size surface for longer reports and context.', tag: 'Fullscreen' },
  { id: 'shortcuts', icon: 'command', title: 'Keyboard reference', description: 'Discover how to navigate without a pointing device.', tag: 'Help' },
  { id: 'playground', icon: 'settings', title: 'Dialog behavior lab', description: 'Try size, outside-click dismissal, and busy-state rules.', tag: 'Interactive' },
]
export function OverlayGallery() {
  const [modal, setModal] = useState<DemoModal>(null)
  const [values, setValues] = useState({ ...initialSettings })
  const [saved, setSaved] = useState({ ...initialSettings })
  const [step, setStep] = useState(0)
  const [name, setName] = useState('Research assistant')
  const [task, setTask] = useState('Summarize the task and return a reviewable result.')
  const [resource, setResource] = useState('website')
  const [size, setSize] = useState<NonNullable<DialogProps['size']>>('lg')
  const [outside, setOutside] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [notes, setNotes] = useState(true)
  const { notify } = useToast()
  const close = (open: boolean) => { if (!open) setModal(null) }
  const done = (title: string) => { setModal(null); notify({ title, description: 'Preview only. No backend change was made.', tone: 'success' }) }
  return <div className="v2-gallery" data-v2-view="overlays"><div className="v2-section-kicker">SURFACES THAT FIT THE TASK <span>/</span> 11 INTERACTIVE EXAMPLES</div>
    <PageHeader title="The right amount of focus." description="Small confirmations. Deep configuration. Full workspaces. One consistent interaction language." />
    <div className="v2-featured-modal"><div><Badge tone="accent">New in 2.0</Badge><h2>Configuration without the clutter.</h2><p>Search a setting. See where it comes from. Review the change. Keep your draft when something goes wrong.</p><Button variant="primary" onClick={() => setModal('settings')}>Explore advanced settings<Icon name="chevron" size={16} /></Button></div>
      <div className="v2-modal-sketch" aria-hidden="true"><div><i /><i /><i /><span>Builder configuration</span></div><section><aside><b>Identity</b><b>Model & runtime</b><b>Execution</b><b>Security</b></aside><article><span className="v2-sketch-search">Search settings…</span><strong>Model & runtime</strong><span>Harness <em>Inherited</em></span><p>Codex <small>⌄</small></p><span>Model selection</span><p>Harness default <small>⌄</small></p><button type="button" tabIndex={-1}>Save changes</button></article></section></div></div>
    <div className="v2-modal-grid">{modalCards.map(card => <button type="button" className="v2-modal-card" key={card.id} data-v2-modal={card.id} onClick={() => { if (card.id === 'wizard') setStep(0); setModal(card.id) }}>
      <div><span className="v2-card-icon"><Icon name={card.icon} size={21} /></span><Badge>{card.tag}</Badge></div><h3>{card.title}</h3><p>{card.description}</p><span className="v2-card-link">Open example <Icon name="chevron" size={14} /></span></button>)}</div>
    <Card><CardHeader title="Menus with depth, not guesswork" description="Actions, checkboxes, radio groups, nested options, disabled explanations, and keyboard navigation." /><CardBody><div className="n-actions">
      <ActionMenu label="Try advanced dropdown" triggerLabel="Agent actions" icon="bot" items={[
        { id: 'open', label: 'Configure agent…', icon: 'settings', shortcut: '↵', onSelect: () => setModal('settings') },
        { id: 'view', label: 'Inspect', kind: 'submenu', items: [{ id: 'details', label: 'Details panel…', onSelect: () => setModal('inspector') }, { id: 'artifacts', label: 'Artifacts…', onSelect: () => setModal('fullscreen') }] },
        { id: 'notifications', label: 'Show activity notes', kind: 'checkbox', checked: notes, onCheckedChange: setNotes },
        { id: 'group', kind: 'separator', label: 'Permissions' }, { id: 'restricted', label: 'Change owner policy', disabled: true, description: 'Owner capability required.', onSelect: () => {} },
        { id: 'delete', label: 'Remove agent…', icon: 'close', danger: true, onSelect: () => setModal('confirm') },
      ]} /><Badge>{notes ? 'Activity notes on' : 'Activity notes off'}</Badge></div></CardBody></Card>
    <SettingsDialog open={modal === 'settings'} onOpenChange={close} title="Builder configuration" description="Capability-driven UI · sample data only" fields={settingsFields.map(field => ({ ...field, overridden: initialSettings[field.id] !== values[field.id] }))}
      values={values} onValueChange={(id, value) => setValues(previous => ({ ...previous, [id]: value }))} onResetField={id => setValues(previous => ({ ...previous, [id]: initialSettings[id] }))}
      dirty={JSON.stringify(saved) !== JSON.stringify(values)} conflict={conflict ? 'The stored version changed. Refresh and reconcile before saving.' : undefined}
      footerNote={<button type="button" className="v2-text-link" onClick={() => setConflict(value => !value)}>{conflict ? 'Clear sample conflict' : 'Simulate a save conflict'}</button>}
      onSave={() => { setSaved({ ...values }); notify({ title: 'Sample settings saved', description: 'Your local preview draft was applied.' }) }} />
    <WizardDialog open={modal === 'wizard'} onOpenChange={close} title="Create an agent" description="A guided example. This does not create a real agent." current={step} onStepChange={setStep} completeLabel="Create sample agent" onComplete={() => done('Sample agent created')}
      steps={[{ id: 'task', title: 'Identity', description: 'Give this agent a clear purpose.', content: <div className="n-stack"><TextField label="Agent name" required value={name} onChange={event => setName(event.currentTarget.value)} /><Textarea label="Task instructions" required value={task} onChange={event => setTask(event.currentTarget.value)} /></div>, canContinue: Boolean(name.trim() && task.trim()) },
        { id: 'runtime', title: 'Runtime', description: 'Capabilities come from the real harness catalog.', content: <div className="n-stack"><Select label="Harness" defaultValue="codex" options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]} /><Alert title="Permissions are not inferred" tone="warning">The production flow must use the explicit supported sandbox and approval policy.</Alert></div> },
        { id: 'review', title: 'Review', content: <div className="n-stack"><Alert title={name || 'Unnamed agent'} tone="accent">{task}</Alert><Badge>Preview only · no API request</Badge></div> }]} />
    <ReviewChangesDialog open={modal === 'review'} onOpenChange={close} title="Review configuration changes" description="See the exact values that will change." canApply changes={[{ id: 'timeout', label: 'Timeout (seconds)', before: '300', after: '600' }, { id: 'motion', label: 'Connection motion', before: false, after: true }, { id: 'secret', label: 'Credential reference', before: 'old-sample-reference', after: 'new-sample-reference', secret: true }]} onApply={() => done('Sample changes applied')} />
    <ResourcePickerDialog open={modal === 'picker'} onOpenChange={close} title="Choose a workspace" selectedId={resource} onSelect={setResource} onConfirm={() => done('Sample workspace selected')}
      resources={[{ id: 'website', title: 'Website', description: 'Local workspace · 4 agents', meta: 'Active' }, { id: 'research', title: 'Research', description: 'Local workspace · 2 agents' }, { id: 'protected', title: 'Protected workspace', description: 'You do not have access.', disabled: true }]} />
    <ProgressDialog open={modal === 'progress'} onOpenChange={close} title="Preparing the workspace" description="Sample progress, not a running operation." status="Verifying configuration" value={68} steps={[{ id: '1', label: 'Resolve workspace', complete: true }, { id: '2', label: 'Check capabilities', complete: true }, { id: '3', label: 'Verify configuration', complete: false }]} />
    <BottomSheet open={modal === 'sheet'} onOpenChange={close} title="Continue with this result" description="Choose a focused next action."><div className="n-stack"><Button onClick={() => setModal('review')}>Review changes</Button><Button onClick={() => setModal('picker')}>Choose a workspace</Button><Button onClick={() => setModal('inspector')}>Inspect agent</Button></div></BottomSheet>
    <Drawer open={modal === 'inspector'} onOpenChange={close} title="Builder · inspector" description="Read task context without leaving the workflow."><AgentActivityPanel name="Builder" status="Working" summary="Implementing the task within the workspace scope." steps={[{ id: '1', label: 'Read repository instructions', state: 'complete' }, { id: '2', label: 'Apply scoped changes', state: 'active' }, { id: '3', label: 'Return artifacts', state: 'waiting' }]} /><div className="v2-panel-spacer" /><ActionMenu label="Inspector dropdown" triggerLabel="Inspect more" items={[{ id: 'artifacts', label: 'Open artifacts…', onSelect: () => setModal('fullscreen') }, { id: 'policy', label: 'Read effective policy', disabled: true, description: 'Connect a real API to inspect policy.', onSelect: () => {} }]} /></Drawer>
    <Dialog open={modal === 'fullscreen'} onOpenChange={close} title="Artifact workspace" description="A focused view for long outputs and verification notes." size="full"><div className="n-stack"><Alert title="Reviewable outputs" tone="accent">Artifacts describe results and evidence. No private reasoning is exposed.</Alert><CodeBlock label="Sample run report" code={'# Website workflow\n\n## Changed files\n- src/landing.tsx\n- src/landing.test.tsx\n\n## Verification\nSample run completed after a visible retry.\n\n## Scope\nWorkspace only; approvals remain explicit.\n\nThis is demonstration content, not a real test result.'} copy={false} /></div></Dialog>
    <ConfirmDialog open={modal === 'confirm'} onOpenChange={close} title="Remove Builder?" description="This is a destructive-action specimen. No production agent will be removed." confirmation="Builder" confirmLabel="Remove sample agent" onConfirm={() => done('Sample removal confirmed')} />
    <Dialog open={modal === 'shortcuts'} onOpenChange={close} title="Keyboard reference"><KeyboardShortcuts groups={[{ title: 'Navigate', shortcuts: [{ label: 'Open command center', keys: ['⌘ / Ctrl', 'K'] }, { label: 'Move through controls', keys: ['Tab'] }] }, { title: 'Menus and dialogs', shortcuts: [{ label: 'Move through a menu', keys: ['↑', '↓'] }, { label: 'Open / leave submenu', keys: ['→', '←'] }, { label: 'Close topmost surface', keys: ['Esc'] }] }]} /></Dialog>
    <Dialog open={modal === 'playground'} onOpenChange={close} title="Dialog behavior lab" description="Try the modal controls below. Busy state blocks dismissal until you turn it off." size={size} dismissible={!busy} busy={busy} closeOnOutsideClick={outside}>
      <div className="n-stack"><Select label="Dialog size" value={size} options={['sm', 'md', 'lg', 'xl', 'full'].map(value => ({ value, label: value === 'full' ? 'Fullscreen' : value.toUpperCase() }))} onChange={event => setSize(event.currentTarget.value as NonNullable<DialogProps['size']>)} />
      <Switch label="Close on outside click" checked={outside} onChange={event => setOutside(event.currentTarget.checked)} /><Switch label="Simulate busy state" checked={busy} onChange={event => setBusy(event.currentTarget.checked)} /><Alert title="Safe defaults" tone="neutral">Outside-click dismissal is off by default. Busy operations cannot be dismissed accidentally.</Alert></div>
    </Dialog>
  </div>
}

export function PatternGallery() {
  const [notifications, setNotifications] = useState(sampleNotifications)
  const [selected, setSelected] = useState<string[]>(['read'])
  const [filters, setFilters] = useState([{ id: 'active', label: 'Status: active' }, { id: 'workspace', label: 'Workspace: Website' }])
  const [files, setFiles] = useState<readonly File[]>([])
  const { notify } = useToast()
  return <div className="v2-gallery" data-v2-view="patterns"><div className="v2-section-kicker">THE MOMENTS BETWEEN THE HAPPY PATHS</div><PageHeader title="A more complete workspace." description="Selection, access, feedback, limits, and recovery belong in the system—not in one-off screens." />
    <div className="v2-pattern-grid"><Card><CardHeader title="Attention, organized" description="Persistent, filterable notifications. Nothing vanishes on a timer." /><CardBody><NotificationCenter items={notifications} onRead={id => setNotifications(items => items.map(item => item.id === id ? { ...item, unread: false } : item))} onOpen={id => notify({ title: `Inspect sample ${id}`, description: 'Open the Execution lab to explore the related replay step.' })} onClearRead={() => setNotifications(items => items.filter(item => item.unread))} /></CardBody></Card>
    <Card><CardHeader title="Context that stays in your control" description="File selection and validation, without a hidden upload." /><CardBody><FileDropzone onFiles={setFiles} />{files.length > 0 && <ul className="v2-file-list">{files.map((file, index) => <li key={`${file.name}-${index}`}><Icon name="code" size={14} />{file.name}<Badge>{Math.ceil(file.size / 1024)} KB</Badge></li>)}</ul>}</CardBody></Card>
    <Card><CardHeader title="Focused selection" description="Search a long list without clearing what you already selected." /><CardBody><div className="n-stack"><MultiSelect label="Tool categories" values={selected} onValuesChange={setSelected} options={[{ value: 'read', label: 'Read workspace' }, { value: 'write', label: 'Edit files' }, { value: 'test', label: 'Run approved tests' }, { value: 'network', label: 'Network access · unavailable', disabled: true }]} hint="A selection specimen—not a permission grant." /><FilterChips filters={filters} onRemove={id => setFilters(items => items.filter(item => item.id !== id))} onClear={() => setFilters([])} /></div></CardBody></Card>
    <Card><CardHeader title="Boundaries you can see" description="Read-only views do not silently turn into editable controls." /><CardBody><PermissionMatrix rows={[{ id: 'read', resource: 'Read repository', scope: 'Website', allowed: true }, { id: 'write', resource: 'Write repository', scope: 'Website', allowed: false, reason: 'Read-only agent' }, { id: 'network', resource: 'Network access', scope: 'Not granted', allowed: false }]} /></CardBody></Card>
    <Card><CardHeader title="Failures with a next step" description="Original error, clear recovery, no pretend success." /><CardBody><FailureRecovery title="Output delivery was interrupted" description="The result has not been confirmed. Your local draft is unchanged." onInspect={() => notify({ title: 'Sample failure details', description: 'No real connection failure occurred.' })} onRetry={() => notify({ title: 'Sample retry requested', description: 'Production must wait for server acknowledgement.' })} /></CardBody></Card>
    <Card><CardHeader title="Honest resource reporting" description="Unknown measurements stay unknown." /><CardBody><div className="n-stack"><BudgetMeter label="Context usage" used={29000} limit={32000} format={value => `${Math.round(value / 1000)}k`} hint="Sample: near the configured limit." /><BudgetMeter label="Provider cost" hint="Not supplied by this preview; no estimated bill is invented." /></div></CardBody></Card></div>
  </div>
}
