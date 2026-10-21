import { PRODUCT_NAME } from '@foreman-code/contracts/product'
import { ExecutionLab, OverlayGallery, PatternGallery } from './V2Showcase'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Icon, Button, IconButton, Badge, StatusBadge, Avatar, AvatarGroup, Breadcrumbs, NavItem,
  PageHeader, MetricCard, Card, CardHeader, CardBody, CardFooter, Tabs, SegmentedControl,
  WorkflowNodeCard, ApprovalCard, Progress, RunSummary, Timeline, LogViewer, DataTable,
  TextField, SearchField, Textarea, Select, Checkbox, Switch, RadioGroup, Slider, Combobox,
  Alert, ConnectionBanner, EmptyState, ErrorState, LoadingState, Spinner, Skeleton,
  Dialog, Drawer, ConfirmDialog, Tooltip, DropdownMenu, CommandPalette, CodeBlock,
  SettingsSection, SettingRow, InheritedValue, SaveBar, PermissionNotice, Pagination,
  Accordion, Kbd, Divider, useToast, type Tone, type IconName,
  MessageBubble, MessageComposer, ToolCallCard, ArtifactCard,
} from '../../shared/ui/nocturne'

// All fixtures and local mutations below are intentionally isolated from production API/state.
const nodes = [
  { id: 'planner', title: 'Planner', subtitle: 'Codex · Planning', statusLabel: 'Complete', tone: 'success' as Tone, icon: 'workflow' as IconName, detail: 'Brief structured into 6 tasks', meta: '38s', x: 26, y: 160 },
  { id: 'builder', title: 'Builder', subtitle: 'Codex · Implementation', statusLabel: 'Working', tone: 'accent' as Tone, icon: 'code' as IconName, detail: 'Building the landing page', meta: '1m 24s', x: 294, y: 66 },
  { id: 'reviewer', title: 'Reviewer', subtitle: 'Claude · Review', statusLabel: 'Waiting', tone: 'warning' as Tone, icon: 'eye' as IconName, detail: 'Starts after implementation', meta: 'Read only', x: 562, y: 160 },
  { id: 'tester', title: 'Tester', subtitle: 'Claude · Verification', statusLabel: 'Queued', tone: 'neutral' as Tone, icon: 'terminal' as IconName, detail: 'Waiting for build artifacts', meta: 'Next', x: 294, y: 264 },
] as const
const runs = [
  { id: '#1048', task: 'Build a product landing page', status: 'Running', tone: 'accent' as Tone, agents: 4, duration: '1m 24s', time: 'Just now' },
  { id: '#1047', task: 'Refine the onboarding flow', status: 'Complete', tone: 'success' as Tone, agents: 3, duration: '2m 18s', time: '12 minutes ago' },
  { id: '#1046', task: 'Add keyboard shortcuts', status: 'Complete', tone: 'success' as Tone, agents: 2, duration: '1m 42s', time: '38 minutes ago' },
  { id: '#1045', task: 'Verify workspace controls', status: 'Failed', tone: 'danger' as Tone, agents: 3, duration: '3m 08s', time: '1 hour ago' },
]
function subscribeRoute(callback: () => void) { window.addEventListener('hashchange', callback); return () => window.removeEventListener('hashchange', callback) }
function getRoute() { const route = window.location.hash.slice(2); return ['studio', 'components', 'settings', 'lab', 'overlays', 'patterns'].includes(route) ? route : 'lab' }
function navigate(view: string) { window.location.hash = `/${view}` }
function DemoSection({ title, description, children, action }: { title: string; description: string; children: ReactNode; action?: ReactNode }) {
  return <Card><CardHeader title={title} description={description} action={action} /><CardBody>{children}</CardBody></Card>
}

export function ToolkitShowcase() {
  const view = useSyncExternalStore(subscribeRoute, getRoute, () => 'studio')
  const [commandOpen, setCommandOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [configureOpen, setConfigureOpen] = useState(false)
  const [selected, setSelected] = useState('builder')
  const { notify } = useToast()
  const selectedNode = nodes.find((node) => node.id === selected) ?? nodes[1]
  function navigation() {
    return <><a className="d-brand" href="#/studio"><span className="d-brand-icon"><Icon name="workflow" size={21} /></span><strong>{PRODUCT_NAME}<span>WORKSPACE</span></strong><Badge>Nocturne</Badge></a>
      <button className="d-workspace-switcher" type="button" onClick={() => setCommandOpen(true)}><Avatar name="Personal workspace" size="sm" /><span>Personal workspace<small>Local environment</small></span><Icon name="down" size={13} /></button>
      <button className="d-search-launcher" type="button" onClick={() => setCommandOpen(true)}><Icon name="search" size={15} /><span>Jump to…</span><Kbd>⌘ K</Kbd></button>
      <nav aria-label="Preview navigation" onClick={(event) => { if ((event.target as HTMLElement).closest('a')) setMobileOpen(false) }}><p className="d-nav-label">Workspace</p>
        <NavItem href="#/lab" active={view === 'lab'} icon="spark">Execution lab</NavItem>
        <NavItem href="#/overlays" active={view === 'overlays'} icon="grid">Dialogs & menus</NavItem>
        <NavItem href="#/patterns" active={view === 'patterns'} icon="bell">Workspace patterns</NavItem>
        <NavItem href="#/studio" active={view === 'studio'} icon="workflow">Workflow studio</NavItem>
        <NavItem href="#/components" active={view === 'components'} icon="grid">Component library</NavItem>
        <NavItem href="#/settings" active={view === 'settings'} icon="settings">Settings</NavItem>
        <p className="d-nav-label d-nav-label--spaced">Your workflows</p><a href="#/studio" className="d-workflow-link"><span className="d-small-dot" />Website workflow<Badge tone="accent">4</Badge></a>
      </nav><div className="d-sidebar-bottom"><div className="d-local-status"><span className="d-small-dot" /><span>Preview environment</span><Icon name="info" size={14} /></div>
        <div className="d-profile"><Avatar name="Alex" /><span>Alex<small>Workspace owner</small></span><Badge>Local</Badge></div></div></>
  }
  return <div className="n-theme d-app"><a className="d-skip" href="#demo-main" onClick={(event) => { event.preventDefault(); document.getElementById('demo-main')?.focus() }}>Skip to content</a>
    <aside className="d-sidebar">{navigation()}</aside><div className="d-main-wrap"><header className="d-topbar"><div className="d-topbar-start"><IconButton className="d-mobile-menu" label="Open navigation" variant="ghost" onClick={() => setMobileOpen(true)}><Icon name="menu" /></IconButton>
      <Breadcrumbs items={[{ label: 'Personal workspace', href: '#/studio' }, { label: view === 'studio' ? 'Workflows' : view === 'components' ? 'Design system' : view === 'settings' ? 'Settings' : view === 'lab' ? 'Execution lab' : view === 'overlays' ? 'Dialogs & menus' : 'Workspace patterns' }]} /></div>
      <div className="n-actions"><span className="d-preview-label"><span className="d-small-dot" />Demo data · no backend</span><Tooltip content="Search the preview with Command K or Control K."><IconButton label="Open command center" variant="ghost" onClick={() => setCommandOpen(true)}><Icon name="command" /></IconButton></Tooltip><Avatar name="Alex" size="sm" /></div></header>
      <main id="demo-main" className="d-main" tabIndex={-1}>
        {view === 'lab' && <ExecutionLab />}
        {view === 'overlays' && <OverlayGallery />}
        {view === 'patterns' && <PatternGallery />}
        {view === 'studio' && <Studio selected={selected} onSelect={setSelected} onConfigure={() => setConfigureOpen(true)} />}
        {view === 'components' && <Components onCommand={() => setCommandOpen(true)} />}
        {view === 'settings' && <SettingsPreview />}
      </main><footer className="d-footer"><span>Nocturne UI <span className="d-footer-separator">/</span> Built for focus.</span><span>React + TypeScript <span className="d-footer-separator">·</span> Keyboard ready</span></footer>
    </div>
    <Drawer open={mobileOpen} onOpenChange={setMobileOpen} title="Workspace navigation"><div className="d-mobile-navigation">{navigation()}</div></Drawer>
    <Drawer open={configureOpen} onOpenChange={setConfigureOpen} title={`Configure ${selectedNode.title}`} description="Preview settings only. No harness configuration is changed."
      footer={<><Button onClick={() => setConfigureOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { setConfigureOpen(false); notify({ title: 'Preview configuration saved', description: 'No production settings were changed.', tone: 'success' }) }}>Save preview</Button></>}>
      <div className="n-stack"><Badge tone="accent">Agent override</Badge><TextField label="Agent name" defaultValue={selectedNode.title} /><Select label="Harness" defaultValue="codex" options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]} /><Textarea label="Instructions" defaultValue="Follow the repository instructions. Keep changes focused and verify your work." /><PermissionNotice title="Permissions stay explicit" description="A workspace directory is not a sandbox. The real feature must use the authorized harness security setting." /></div>
    </Drawer>
    <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} commands={[
      { id: 'lab', label: 'Explore agent execution', description: 'Handoffs, approvals, retries and replay', icon: 'spark', group: 'Navigate', onSelect: () => navigate('lab') },
      { id: 'overlays', label: 'Explore dialogs and advanced settings', description: 'Configuration and modal interactions', icon: 'settings', group: 'Navigate', onSelect: () => navigate('overlays') },
      { id: 'patterns', label: 'Explore workspace patterns', description: 'Notifications, permissions and context', icon: 'bell', group: 'Navigate', onSelect: () => navigate('patterns') },
      { id: 'studio', label: 'Open workflow studio', description: 'Nodes, execution and approvals', icon: 'workflow', group: 'Navigate', onSelect: () => navigate('studio') },
      { id: 'components', label: 'Explore the component library', description: 'Controls, states and patterns', icon: 'grid', group: 'Navigate', keywords: 'design tokens UI', onSelect: () => navigate('components') },
      { id: 'settings', label: 'Open workspace settings', description: 'Defaults, inheritance and security', icon: 'settings', group: 'Navigate', onSelect: () => navigate('settings') },
      { id: 'configure', label: `Configure ${selectedNode.title}`, description: 'Open the agent inspector', icon: 'bot', group: 'Action', onSelect: () => setConfigureOpen(true) },
    ]} />
  </div>
}

function Studio({ selected, onSelect, onConfigure }: { selected: string; onSelect: (id: string) => void; onConfigure: () => void }) {
  const [tab, setTab] = useState('canvas')
  const [inspectorTab, setInspectorTab] = useState('details')
  const [layout, setLayout] = useState('graph')
  const [zoom, setZoom] = useState(100)
  const [resolved, setResolved] = useState<string>()
  const [offline, setOffline] = useState(false)
  const [runDialog, setRunDialog] = useState(false)
  const { notify } = useToast()
  const node = nodes.find((candidate) => candidate.id === selected) ?? nodes[1]
  const activity = <Timeline items={[
    { id: '1', title: 'Planner completed the brief', description: '6 tasks handed to the Builder.', time: '14:32:08', tone: 'success' },
    { id: '2', title: 'Builder started implementation', description: 'Workspace prepared. Changes are isolated.', time: '14:32:10', tone: 'accent' },
    { id: '3', title: 'Approval requested', description: 'Run the test suite for this change.', time: '14:33:21', tone: 'warning' },
  ]} />
  const graph = <div className="d-workspace-grid"><div className="d-execution-area"><div className="d-canvas-card"><div className="d-canvas-toolbar"><div className="n-actions"><span className="d-small-dot" /><strong>Execution map</strong><span className="d-canvas-count">4 agents · 4 connections</span></div><SegmentedControl label="Workflow visualization" value={layout} onValueChange={setLayout} options={[{ value: 'graph', label: 'Graph', icon: 'workflow' }, { value: 'list', label: 'List', icon: 'menu' }]} /></div>
    {layout === 'graph' ? <div className="d-canvas" role="region" aria-label="Workflow execution map. Select any agent to inspect it." tabIndex={0}><div className="d-scaled-board" style={{ width: 800 * zoom / 100, height: 452 * zoom / 100 }}><div className="d-board" style={{ transform: `scale(${zoom / 100})` }}>
      <svg className="d-connections" width="800" height="452" viewBox="0 0 800 452" aria-hidden="true"><path className="d-edge d-edge--complete" d="M234 226H255Q265 226 265 216V142Q265 132 275 132H294" /><path className="d-edge d-edge--active" d="M502 132H518Q529 132 529 143V215Q529 226 540 226H562" /><path className="d-edge" d="M234 226H255Q265 226 265 237V324Q265 334 275 334H294" /><path className="d-edge" d="M502 334H518Q529 334 529 323V237Q529 226 540 226H562" /><circle cx="264" cy="226" r="4" /><circle cx="529" cy="226" r="4" /></svg>
      <span className="d-edge-label d-edge-label--a">build</span><span className="d-edge-label d-edge-label--b">review</span><span className="d-edge-label d-edge-label--c">verify</span>
      {nodes.map((item) => <div key={item.id} className="d-positioned-node" style={{ left: item.x, top: item.y }}><WorkflowNodeCard {...item} selected={item.id === selected} working={item.id === 'builder'} progress={item.id === 'builder' ? 62 : undefined} onSelect={() => onSelect(item.id)} /></div>)}
    </div></div></div> : <div className="d-node-list">{nodes.map((item) => <WorkflowNodeCard key={item.id} {...item} selected={item.id === selected} working={item.id === 'builder'} onSelect={() => onSelect(item.id)} />)}</div>}
    <div className="d-canvas-bottom"><span><Icon name="lock" size={12} />Workspace-scoped execution</span>{layout === 'graph' && <div className="d-zoom"><IconButton label="Zoom out" size="sm" variant="ghost" disabled={zoom <= 70} onClick={() => setZoom((value) => Math.max(70, value - 10))}><Icon name="minus" size={13} /></IconButton><output aria-label="Zoom level">{zoom}%</output><IconButton label="Zoom in" size="sm" variant="ghost" disabled={zoom >= 130} onClick={() => setZoom((value) => Math.min(130, value + 10))}><Icon name="plus" size={13} /></IconButton><IconButton label="Reset zoom" size="sm" variant="ghost" onClick={() => setZoom(100)}><Icon name="maximize" size={13} /></IconButton></div>}</div>
    </div>
    <ApprovalCard title="Run the project test suite" description="Builder wants to verify its changes before passing the work to Reviewer." scope="This command · this run only" canRespond={!offline} resolvedLabel={resolved} unavailableReason="Connection lost. Reconnect before responding."
      choices={[{ id: 'deny-once', label: 'Deny', description: 'Do not run this command.' }, { id: 'allow-once', label: 'Allow once', description: 'No persistent permission.' }]}
      context={<div className="d-approval-command"><Icon name="terminal" size={15} /><code>corepack pnpm test</code><Badge>Demo</Badge></div>}
      onChoose={(id) => { setResolved(id === 'allow-once' ? 'Allowed once' : 'Denied'); notify({ title: 'Preview decision recorded', description: 'No command was executed.', tone: 'info' }) }} />
  </div><aside className="d-inspector" aria-label="Selected agent inspector"><div className="d-inspector-heading"><span className="d-inspector-icon"><Icon name={node.icon} size={22} /></span><div><h2>{node.title}</h2><p>{node.subtitle}</p></div><Badge tone={node.tone}>{node.statusLabel}</Badge></div>
    <Tabs label="Agent inspector" value={inspectorTab} onValueChange={setInspectorTab} items={[
      { value: 'details', label: 'Details', content: <div className="n-stack"><div><p className="n-eyebrow">Current task</p><p className="d-current-task">{node.detail}</p></div><Divider /><dl className="d-detail-list"><div><dt>Harness</dt><dd>{node.subtitle.split(' · ')[0]}</dd></div><div><dt>Execution</dt><dd>Local</dd></div><div><dt>Permission scope</dt><dd>{node.id === 'reviewer' ? 'Read only' : 'Workspace'}</dd></div><div><dt>Configuration</dt><dd><Badge tone="neutral">Inherited</Badge></dd></div></dl><InheritedValue source="Website workflow" /><Divider /><Progress label="Task progress" value={node.id === 'builder' ? 62 : node.id === 'planner' ? 100 : 0} tone={node.tone} /><Button onClick={onConfigure} leading={<Icon name="settings" size={15} />}>Configure agent</Button><div className="d-inspector-note"><Icon name="info" size={15} /><p>Settings follow a clear hierarchy: global → workspace → workflow → agent.</p></div></div> },
      { value: 'activity', label: 'Activity', content: activity },
    ]} />
  </aside></div>
  return <><PageHeader eyebrow="ORCHESTRATION / WEBSITE" title="Website workflow" description="From the first idea to a working website. Every step, in view." actions={<><DropdownMenu label="Workflow preview options" items={[{ id: 'offline', label: offline ? 'Restore connection preview' : 'Preview connection loss', icon: 'globe', onSelect: () => setOffline(!offline) }, { id: 'reset', label: 'Reset approval preview', icon: 'refresh', onSelect: () => setResolved(undefined) }]} /><Button variant="primary" leading={<Icon name="play" size={14} />} onClick={() => setRunDialog(true)}>Run preview</Button></>} />
    <ConnectionBanner state={offline ? 'offline' : 'connected'} onRetry={() => setOffline(false)} />
    <div className="d-metrics"><MetricCard label="Runs today" value="24" note="Across all workflows" icon="workflow" /><MetricCard label="Agents available" value="4" note="2 Codex · 2 Claude" icon="bot" tone="accent" /><MetricCard label="Success rate" value="96%" note="Last 25 completed runs" icon="check" tone="success" /><MetricCard label="Average duration" value="2m 14s" note="From start to completion" icon="clock" /></div>
    <Tabs label="Workflow view" value={tab} onValueChange={setTab} items={[{ value: 'canvas', label: 'Canvas', content: graph }, { value: 'runs', label: 'Runs', badge: 4, content: <RunsTable /> }, { value: 'activity', label: 'Activity', content: <Card><CardBody>{activity}<LogViewer lines={[{ id: 'l1', timestamp: '14:32:08', message: 'Planner completed · 6 tasks ready', tone: 'success' }, { id: 'l2', timestamp: '14:32:10', message: 'Builder started in the workspace', tone: 'accent' }, { id: 'l3', timestamp: '14:33:21', message: 'Waiting for a scoped approval decision', tone: 'warning' }]} /></CardBody></Card> }]} />
    {tab === 'canvas' && <div className="d-recent-runs"><div className="d-section-heading"><h2>Recent runs</h2><Button size="sm" variant="ghost" trailing={<Icon name="arrow" size={14} />} onClick={() => setTab('runs')}>View all runs</Button></div><RunsTable compact /></div>}
    <Dialog open={runDialog} onOpenChange={setRunDialog} title="Start a preview run" description="This demonstrates the run dialog. It cannot execute code or contact your backend." footer={<><Button onClick={() => setRunDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => { setRunDialog(false); notify({ title: 'Preview run started', description: 'The canvas shows sample activity only.', tone: 'success' }) }}>Start preview</Button></>}>
      <div className="n-stack"><Textarea label="What should the agents build?" defaultValue="Build a clean product landing page with a clear call to action." /><Alert title="Your workflow stays unchanged" tone="info">The preview has no API client, credentials, or runtime connection.</Alert></div>
    </Dialog>
  </>
}

function RunsTable({ compact = false }: { compact?: boolean }) {
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' }>({ column: 'id', direction: 'desc' })
  const filtered = runs.filter((run) => filter === 'all' || run.status.toLowerCase() === filter).sort((a, b) => {
    const left = sort.column === 'task' ? a.task : a.id
    const right = sort.column === 'task' ? b.task : b.id
    return left.localeCompare(right) * (sort.direction === 'asc' ? 1 : -1)
  }).slice(0, compact ? 3 : undefined)
  return <div className="d-runs-table">{!compact && <div className="d-table-filter"><Select label="Filter runs" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} options={[{ value: 'all', label: 'All statuses' }, { value: 'running', label: 'Running' }, { value: 'complete', label: 'Complete' }, { value: 'failed', label: 'Failed' }]} /><Badge>Sample runs</Badge></div>}
    <DataTable label="Sample workflow runs" rows={filtered} rowKey={(run) => run.id} sort={sort} onSortChange={setSort} columns={[
      { id: 'id', header: 'Run', sortable: true, render: (run) => <span className="n-mono">{run.id}</span> },
      { id: 'task', header: 'Task', sortable: true, render: (run) => <span className="d-table-task">{run.task}</span> },
      { id: 'status', header: 'Status', render: (run) => <StatusBadge label={run.status} tone={run.tone} busy={run.status === 'Running'} /> },
      { id: 'agents', header: 'Agents', render: (run) => <span className="d-table-agents"><Icon name="bot" size={14} />{run.agents}</span> },
      { id: 'duration', header: 'Duration', render: (run) => <span className="n-mono">{run.duration}</span> },
      { id: 'time', header: 'Started', align: 'end', render: (run) => run.time },
    ]} />
  </div>
}

function Components({ onCommand }: { onCommand: () => void }) {
  const [switchOn, setSwitchOn] = useState(true)
  const [tab, setTab] = useState('overview')
  const [density, setDensity] = useState('comfortable')
  const [harness, setHarness] = useState('codex')
  const [limit, setLimit] = useState(8)
  const [dialog, setDialog] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [scope, setScope] = useState('read')
  const [page, setPage] = useState(1)
  const { notify } = useToast()
  return <><PageHeader eyebrow="NOCTURNE / COMPONENT LIBRARY" title="Every detail, considered." description="A complete interface language for human + agent workflows." actions={<Badge tone="accent">UI toolkit · v1.0</Badge>} />
    <div className="d-library-intro"><div><span className="d-library-tag">CALM BY DEFAULT. CLEAR UNDER PRESSURE.</span><h2>Less noise.<br /><span>More control.</span></h2><p>Purpose-built components. Clear states. Thoughtful interactions.<br />One consistent foundation for the whole workspace.</p></div><div className="d-token-grid">{[['Canvas', '#0e0f14'], ['Surface', '#161820'], ['Raised', '#1c1e29'], ['Accent', '#b9a4ff'], ['Success', '#87dbb0'], ['Warning', '#f0c67c']].map(([name, color]) => <div key={name}><span style={{ background: color }} /><strong>{name}</strong><code>{color}</code></div>)}</div></div>
    <div className="d-component-grid">
      <DemoSection title="Actions" description="Clear emphasis. No accidental form submissions."><div className="n-stack"><div className="n-actions"><Button variant="primary" leading={<Icon name="plus" size={16} />} onClick={() => notify({ title: 'Primary action selected', tone: 'success' })}>Create workflow</Button><Button onClick={() => notify({ title: 'Secondary action selected' })}>Secondary</Button><Button variant="ghost" onClick={onCommand}>Explore</Button></div><div className="n-actions"><Button loading loadingLabel="Saving…">Save</Button><Button disabled>Unavailable</Button><Button variant="danger" onClick={() => setConfirm(true)}>Delete</Button><Tooltip content="Open the searchable command center."><IconButton label="Search commands" onClick={onCommand}><Icon name="search" /></IconButton></Tooltip></div></div></DemoSection>
      <DemoSection title="Status language" description="Text and shape, never color alone."><div className="n-stack"><div className="n-actions"><StatusBadge label="Working" tone="accent" busy /><StatusBadge label="Complete" tone="success" /><StatusBadge label="Waiting" tone="warning" /><StatusBadge label="Failed" tone="danger" /><StatusBadge label="Queued" /></div><Progress label="Workflow progress" value={62} /><div className="n-actions"><Avatar name="Builder" /><AvatarGroup names={['Planner', 'Builder', 'Reviewer', 'Tester', 'Operator']} /><Badge tone="info">Workspace scoped</Badge></div></div></DemoSection>
      <DemoSection title="Input & validation" description="Visible labels and errors that stay connected."><div className="n-stack"><TextField label="Workflow name" defaultValue="Website workflow" hint="A short name that describes the outcome." /><TextField label="Workspace path" defaultValue="../outside-workspace" error="Choose a location within an authorized workspace." /><SearchField label="Search workflows" placeholder="Find a workflow…" /></div></DemoSection>
      <DemoSection title="Selection" description="Native controls where they work best."><div className="n-stack"><Combobox label="Agent harness" options={[{ value: 'codex', label: 'Codex', description: 'Local app-server transport' }, { value: 'claude', label: 'Claude', description: 'Host-local Claude profile' }, { value: 'unavailable', label: 'Unavailable provider', disabled: true }]} value={harness} onValueChange={setHarness} /><Select label="Execution location" options={[{ value: 'local', label: 'Local workspace' }, { value: 'remote', label: 'Remote · not configured', disabled: true }]} /><Slider label="Concurrent tasks" value={limit} min={1} max={16} onValueChange={setLimit} /></div></DemoSection>
      <DemoSection title="Preferences" description="Comfortable targets and unmistakable states."><div className="n-stack"><Switch label="Follow execution output" hint="Pause following when you scroll back." checked={switchOn} onChange={(event) => setSwitchOn(event.currentTarget.checked)} /><Checkbox label="Notify me when a run needs attention" defaultChecked /><Checkbox label="Require a scoped approval" checked disabled /><SegmentedControl label="Display density" value={density} onValueChange={setDensity} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} /></div></DemoSection>
      <DemoSection title="Overlays & commands" description="Escape, focus return and protected decisions."><div className="n-stack"><div className="n-actions"><Button onClick={() => setDialog(true)}>Open dialog</Button><Button onClick={() => setDrawer(true)}>Open drawer</Button><Button onClick={onCommand} leading={<Icon name="command" size={15} />}>Commands</Button><DropdownMenu label="Example actions" items={[{ id: 'details', label: 'View details', icon: 'eye', onSelect: () => setDialog(true) }, { id: 'unavailable', label: 'Unavailable action', disabled: true, onSelect: () => undefined }, { id: 'delete', label: 'Delete preview item', danger: true, icon: 'close', onSelect: () => setConfirm(true) }]} /></div><Button onClick={() => notify({ title: 'Changes saved', description: 'Persistent until you dismiss it.', tone: 'success' })}>Show notification</Button><p className="n-field-hint">Notifications do not disappear while you are reading or acting on them.</p></div></DemoSection>
      <DemoSection title="Tabs & disclosure" description="Arrow keys navigate. Disabled items are skipped."><Tabs label="Example tabs" value={tab} onValueChange={setTab} items={[{ value: 'overview', label: 'Overview', content: <p className="n-muted">A clear overview keeps the next action easy to find.</p> }, { value: 'activity', label: 'Activity', badge: 3, content: <p className="n-muted">Activity is visible without interrupting your work.</p> }, { value: 'disabled', label: 'Unavailable', disabled: true, content: null }]} /><Divider /><Accordion items={[{ id: 'hierarchy', title: 'How does inheritance work?', content: 'Global defaults → workspace → workflow → agent. Overrides are always visible.' }, { id: 'security', title: 'Is a workspace directory a sandbox?', content: 'No. Enforce isolation through the explicit harness security configuration.' }]} /></DemoSection>
      <DemoSection title="Loading & recovery" description="Never leave a blank screen or a dead end."><div className="n-stack"><Alert title="Changes could not be saved" tone="danger">Your draft is still here. Reconnect and try again.</Alert><div className="n-actions"><Spinner label="Loading example" /><span className="n-muted">Loading workspace…</span></div><Skeleton height="10px" width="80%" /><LoadingState rows={2} /></div></DemoSection>
      <DemoSection title="Empty states" description="Explain what happened and what comes next."><EmptyState title="Your next workflow starts here" description="Connect the right agents and give them a clear outcome." icon="workflow" action={<Button variant="primary" onClick={() => setDialog(true)} leading={<Icon name="plus" size={15} />}>Create workflow</Button>} /></DemoSection>
      <DemoSection title="Explicit security" description="No hidden elevation of agent permissions."><RadioGroup label="Harness access" value={scope} onValueChange={setScope} options={[{ value: 'read', label: 'Read only', description: 'Inspect and report. No writes.' }, { value: 'workspace', label: 'Workspace writes', description: 'Only through the harness’s explicit security setting.' }]} /></DemoSection>
      <DemoSection title="Code & output" description="Escaped text with honest clipboard feedback."><CodeBlock label="Import the toolkit" language="tsx" code={'import { Button, Dialog } from "./shared/ui/nocturne"\nimport "./shared/ui/nocturne/nocturne.css"'} /></DemoSection>
      <DemoSection title="Run summaries" description="Important details at a glance."><RunSummary title="Website workflow" status="Working" tone="accent" progress={62} metadata={[{ label: 'Run', value: '#1048' }, { label: 'Elapsed', value: '1m 24s' }, { label: 'Agents', value: '4 assigned' }, { label: 'Location', value: 'Local workspace' }]} /></DemoSection>
      <DemoSection title="Operator conversation" description="Drafts stay until the feature confirms delivery."><ConversationPreview /></DemoSection>
      <DemoSection title="Tools & artifacts" description="Expandable tool output. Permission-filtered metadata."><div className="n-stack"><ToolCallCard title="Inspect repository instructions" status="Complete" tone="success" summary="Sample output only."><CodeBlock label="Tool output" code="Read AGENTS.md. Keep changes focused. No commands executed in this preview." /></ToolCallCard><ArtifactCard title="Implementation plan" description="Six focused tasks for the website workflow." metadata="Markdown · Sample artifact" onOpen={() => notify({ title: 'Artifact preview', description: 'Plan: structure, implementation, checks, review, validation, handoff.' })} /></div></DemoSection>
    </div><div className="d-component-extra"><ErrorState title="Unable to load runs" description="Your workflow is unchanged. Try the request again." onRetry={() => notify({ title: 'Retry preview', description: 'This is a recovery-state example.', tone: 'info' })} /><div><PermissionNotice /><Pagination page={page} totalPages={8} onPageChange={setPage} /><Card><CardHeader title="Card anatomy" description="A predictable header, body and footer." /><CardBody>Reusable structure for settings and inspector panels.</CardBody><CardFooter><Badge>Composed</Badge><Kbd>Tab</Kbd></CardFooter></Card></div></div>
    <Dialog open={dialog} onOpenChange={setDialog} title="Create a workflow" description="A focused dialog with visible labels and native focus containment." footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => { setDialog(false); notify({ title: 'Preview workflow created', tone: 'success' }) }}>Create preview</Button></>}><div className="n-stack"><TextField label="Name" defaultValue="My new workflow" /><Textarea label="Outcome" placeholder="What should this workflow achieve?" /></div></Dialog>
    <Drawer open={drawer} onOpenChange={setDrawer} title="Agent details" description="A spacious side panel without losing context."><RunSummary title="Builder" status="Working" tone="accent" metadata={[{ label: 'Harness', value: 'Codex' }, { label: 'Location', value: 'Local' }]} /><Divider /><PermissionNotice /></Drawer>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this preview item?" description="This is a destructive-action example. No real data will be deleted." confirmation="DELETE" confirmLabel="Delete preview item" onConfirm={() => { setConfirm(false); notify({ title: 'Preview item deleted', description: 'No production data changed.', tone: 'info' }) }} />
  </>
}

function SettingsPreview() {
  const initial = { name: 'Personal workspace', harness: 'codex', notifications: true, access: 'read', concurrency: 4 }
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const { notify } = useToast()
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft)
  function save() {
    if (!draft.name.trim()) { setError('A workspace name is required.'); return }
    setSaved({ ...draft, name: draft.name.trim() }); setDraft({ ...draft, name: draft.name.trim() }); setError(undefined)
    notify({ title: 'Preview settings saved', description: 'Saved in this preview only. Reloading restores the sample.', tone: 'success' })
  }
  return <><PageHeader eyebrow="PERSONAL WORKSPACE / CONFIGURATION" title="Workspace settings" description="Good defaults. Clear inheritance. No hidden surprises." actions={<Badge tone="neutral">Preview only</Badge>} />
    <div className="d-settings-hierarchy"><span>Global defaults</span><Icon name="chevron" size={14} /><span className="d-hierarchy-active">Workspace</span><Icon name="chevron" size={14} /><span>Workflow</span><Icon name="chevron" size={14} /><span>Agent</span><Badge tone="accent">Current level</Badge></div>
    <SettingsSection title="General" description="The basics that make this workspace yours."><TextField label="Workspace name" value={draft.name} error={error} onChange={(event) => { setDraft({ ...draft, name: event.currentTarget.value }); setError(undefined) }} maxLength={80} /><TextField label="Execution location" value="/workspaces/website" readOnly hint="Sample path only. Location access must use the existing authorization boundary." /></SettingsSection>
    <SettingsSection title="Agent defaults" description="Inherited by workflows unless explicitly overridden."><SettingRow title="Default harness" description="Choose the default execution harness." source={<InheritedValue source="Global defaults" overridden={draft.harness !== 'codex'} onReset={() => setDraft({ ...draft, harness: 'codex' })} />}><Select label="Harness" value={draft.harness} onChange={(event) => setDraft({ ...draft, harness: event.currentTarget.value })} options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]} /></SettingRow><Slider label="Concurrent tasks" min={1} max={12} value={draft.concurrency} onValueChange={(concurrency) => setDraft({ ...draft, concurrency })} /></SettingsSection>
    <SettingsSection title="Safety & access" description="Permissions should be deliberate, visible and scoped."><Alert title="A directory is not a sandbox" tone="info">Isolation comes from the harness’s explicit security configuration, not the selected folder.</Alert><RadioGroup label="Preview harness access" value={draft.access} onValueChange={(access) => setDraft({ ...draft, access })} options={[{ value: 'read', label: 'Read only', description: 'Inspect files and report findings.' }, { value: 'workspace', label: 'Workspace writes', description: 'Illustration only. Real access requires an authorized configuration change.' }]} /></SettingsSection>
    <SettingsSection title="Notifications" description="Stay informed without constant interruptions."><Switch label="Needs-attention notifications" hint="Show when an approval, failure or question needs a decision." checked={draft.notifications} onChange={(event) => setDraft({ ...draft, notifications: event.currentTarget.checked })} /><Switch label="Automatic approval" checked={false} disabled hint="Not enabled by the UI toolkit. Permission decisions stay explicit." /></SettingsSection>
    <SettingsSection title="Danger zone" description="Destructive actions require a deliberate confirmation."><SettingRow title="Delete preview workspace" description="This example does not delete any real workspace."><Button variant="danger" onClick={() => setConfirm(true)}>Delete preview workspace</Button></SettingRow></SettingsSection>
    <SaveBar dirty={dirty} error={error} onSave={save} onDiscard={() => { setDraft(saved); setError(undefined) }} />
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete preview workspace?" description="No real workspaces or files will be deleted." confirmation="DELETE" confirmLabel="Delete preview" onConfirm={() => { setConfirm(false); notify({ title: 'Deletion preview complete', description: 'No workspaces or files were deleted.', tone: 'info' }) }} />
  </>
}

function ConversationPreview() {
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<string>()
  return <div className="n-stack"><MessageBubble author="Operator" time="14:33">The Builder is ready for a scoped test approval. Review the exact command before allowing it.</MessageBubble>
    {sent && <MessageBubble author="You" role="user" status={<Badge>Preview</Badge>}>{sent}</MessageBubble>}
    <MessageComposer value={draft} onValueChange={setDraft} label="Preview operator message" placeholder="Try the conversation composer…" onSend={(message) => { setSent(message); setDraft('') }} context={<Badge tone="accent">Website workflow · Demo</Badge>} />
  </div>
}
