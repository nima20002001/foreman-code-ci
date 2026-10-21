import type { ExecutionConnection, ExecutionEvent, ExecutionNode, SettingDefinition, SettingValue, NotificationItem } from '../../shared/ui/nocturne'
// Illustrative view data only. Not API contracts, supported-model catalogs, pricing or permission grants.
export const settingsFields: readonly SettingDefinition[] = [
  { id: 'name', label: 'Agent name', section: 'Identity', type: 'text', required: true, maxLength: 80, description: 'A clear name makes handoffs easier to follow.' },
  { id: 'instructions', label: 'Instructions', section: 'Identity', type: 'textarea', required: true, maxLength: 12000, source: 'Website workflow', description: 'Task instructions for this agent. Keep security settings separate.' },
  { id: 'harness', label: 'Harness', section: 'Model & runtime', type: 'select', options: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }], source: 'Workspace defaults', required: true },
  { id: 'model', label: 'Model selection', section: 'Model & runtime', type: 'select', options: [{ value: 'default', label: 'Harness default' }], description: 'The real feature supplies only models returned by the selected harness.', required: true },
  { id: 'effort', label: 'Reasoning effort', section: 'Model & runtime', type: 'select', advanced: true, options: [{ value: 'default', label: 'Harness default' }], readOnly: true, unavailableReason: 'Load supported reasoning settings from the harness before enabling this field.' },
  { id: 'timeout', label: 'Execution timeout (seconds)', section: 'Execution', type: 'number', min: 30, max: 3600, step: 1, advanced: true, source: 'Workflow limits', description: 'Sample UI limit. The API contract supplies the real allowed range.' },
  { id: 'attempts', label: 'Maximum attempts', section: 'Execution', type: 'number', min: 1, max: 5, step: 1, advanced: true, source: 'Workflow limits', description: 'A retry must still be authorized by the real workflow runtime.' },
  { id: 'directory', label: 'Workspace location', section: 'Security', type: 'text', readOnly: true, source: 'Workspace', description: 'A working directory is not a security boundary.' },
  { id: 'sandbox', label: 'Sandbox policy', section: 'Security', type: 'select', options: [{ value: 'workspace', label: 'Workspace-scoped (sample)' }, { value: 'readonly', label: 'Read-only (sample)' }], source: 'Explicit agent policy', description: 'Illustrative choices. Production must use the harness capability contract.' },
  { id: 'approval', label: 'Approval policy', section: 'Security', type: 'select', options: [{ value: 'required', label: 'Ask before restricted actions' }], source: 'Workspace policy', readOnly: true, unavailableReason: 'This example does not allow weakening approval requirements.' },
  { id: 'tools', label: 'Available tools', section: 'Tools & context', type: 'textarea', readOnly: true, description: 'Tool access comes from the authorized tool catalog, never a free-text grant.' },
  { id: 'context', label: 'Handoff context', section: 'Tools & context', type: 'textarea', advanced: true, description: 'A visible summary for the next agent, not hidden reasoning.' },
  { id: 'motion', label: 'Animate task handoffs', section: 'Interface', type: 'switch', description: 'Affects visualization only, never the execution speed.' },
  { id: 'notify', label: 'Show decision notifications', section: 'Interface', type: 'switch', source: 'Workspace preferences' },
]
export const initialSettings: Record<string, SettingValue> = {
  name: 'Builder', instructions: 'Follow AGENTS.md. Make focused changes, preserve existing behavior, and verify your work.',
  harness: 'codex', model: 'default', effort: 'default', timeout: '600', attempts: '2', directory: '/workspaces/website', sandbox: 'workspace',
  approval: 'required', tools: 'read_file · apply_patch · scoped_terminal', context: 'Pass the changed files, test results, and known limitations to Reviewer.', motion: true, notify: true,
}
export function settingsForAgent(id: string): Record<string, SettingValue> {
  const names: Record<string, string> = { planner: 'Planner', builder: 'Builder', tester: 'Tester', reviewer: 'Reviewer' }
  return { ...initialSettings, name: names[id] ?? 'Builder', harness: ['tester', 'reviewer'].includes(id) ? 'claude' : 'codex',
    sandbox: id === 'reviewer' ? 'readonly' : 'workspace', tools: id === 'reviewer' ? 'read_file · inspect_diff' : initialSettings.tools }
}
export const replayEvents: readonly ExecutionEvent[] = [
  { id: 'plan', title: 'Planner structures the brief', description: 'A request becomes six bounded tasks.', agent: 'Planner', time: '00:00', tone: 'accent', frame: 0 },
  { id: 'handoff', title: 'Plan delivered to Builder', description: 'The brief and acceptance checklist travel together.', agent: 'Planner → Builder', time: '00:12', tone: 'success', frame: 1 },
  { id: 'build', title: 'Builder edits the workspace', description: 'Implementation starts with the approved scope.', agent: 'Builder', time: '00:28', tone: 'accent', frame: 2 },
  { id: 'approval', title: 'Restricted command needs a decision', description: 'The next tool call waits for an explicit response.', agent: 'Builder', time: '00:42', tone: 'warning', frame: 3 },
  { id: 'test', title: 'Tester verifies the handoff', description: 'Test inputs and changed files are attached.', agent: 'Tester', time: '00:56', tone: 'accent', frame: 4 },
  { id: 'failure', title: 'A test failure is reported', description: 'The failure is visible; no silent retry.', agent: 'Tester', time: '01:08', tone: 'danger', frame: 5 },
  { id: 'retry', title: 'Builder corrects the issue', description: 'A second attempt uses the failure report.', agent: 'Builder', time: '01:22', tone: 'accent', frame: 6 },
  { id: 'review', title: 'Reviewer checks the result', description: 'Read-only review of the patch and checks.', agent: 'Reviewer', time: '01:48', tone: 'accent', frame: 7 },
  { id: 'complete', title: 'Result ready for the operator', description: 'Artifacts and verification notes are collected.', agent: 'Workflow', time: '02:04', tone: 'success', frame: 8 },
]
export function replayNodes(frame: number): ExecutionNode[] {
  return [
    { id: 'planner', title: 'Planner', subtitle: 'Codex · Planning', x: 26, y: 160, icon: 'workflow', statusLabel: frame === 0 ? 'Planning' : 'Complete', tone: frame === 0 ? 'accent' : 'success', working: frame === 0, detail: frame === 0 ? 'Structuring the request' : 'Six tasks, one clear brief', meta: '12s' },
    { id: 'builder', title: 'Builder', subtitle: 'Codex · Implementation', x: 294, y: 66, icon: 'code', statusLabel: frame < 1 ? 'Queued' : frame === 3 ? 'Approval needed' : frame === 6 ? 'Retrying' : frame < 4 ? 'Working' : 'Complete', tone: frame < 1 ? 'neutral' : frame === 3 ? 'warning' : [1,2,6].includes(frame) ? 'accent' : 'success', working: [1,2,6].includes(frame), detail: frame === 3 ? 'Waiting to run the test suite' : frame === 6 ? 'Fixing the reported failure' : 'Building the landing page', progress: frame < 1 ? 0 : frame === 6 ? 78 : frame < 4 ? 62 : 100, meta: 'Workspace-scoped' },
    { id: 'tester', title: 'Tester', subtitle: 'Claude · Verification', x: 294, y: 264, icon: 'terminal', statusLabel: frame < 4 ? 'Queued' : frame === 5 ? 'Failed' : frame < 7 ? 'Verifying' : 'Complete', tone: frame < 4 ? 'neutral' : frame === 5 ? 'danger' : frame < 7 ? 'accent' : 'success', working: [4,6].includes(frame), detail: frame === 5 ? 'One assertion needs attention' : 'Checking the implementation', meta: frame > 5 ? 'Attempt 2' : 'Attempt 1' },
    { id: 'reviewer', title: 'Reviewer', subtitle: 'Claude · Review', x: 562, y: 160, icon: 'eye', statusLabel: frame < 7 ? 'Waiting' : frame === 7 ? 'Reviewing' : 'Complete', tone: frame < 7 ? 'neutral' : frame === 7 ? 'accent' : 'success', working: frame === 7, detail: 'Reads the patch and test results', meta: 'Read only' },
  ]
}
export function replayConnections(frame: number): ExecutionConnection[] {
  return [
    { id: 'brief', from: 'planner', to: 'builder', label: 'Task brief', detail: 'Six tasks, acceptance criteria, and allowed workspace scope.', state: frame === 1 ? 'active' : frame > 1 ? 'complete' : 'idle' },
    { id: 'verify', from: 'builder', to: 'tester', label: 'Verification', detail: 'Changed files and expected checks. Tool results are shared, not private reasoning.', state: frame === 3 ? 'blocked' : frame === 5 ? 'failed' : [2,4,6].includes(frame) ? 'active' : frame >= 7 ? 'complete' : 'idle' },
    { id: 'results', from: 'tester', to: 'reviewer', label: 'Test results', detail: 'A bounded test report and artifact references.', state: frame === 7 ? 'active' : frame > 7 ? 'complete' : 'idle' },
    { id: 'patch', from: 'builder', to: 'reviewer', label: 'Patch review', detail: 'The proposed diff, retained permissions, and known limitations.', state: frame === 7 ? 'active' : frame > 7 ? 'complete' : 'idle' },
  ]
}
export const sampleNotifications: NotificationItem[] = [
  { id: 'approval', title: 'Builder needs your approval', description: 'A scoped command is waiting for a response.', time: '1 minute ago', unread: true, tone: 'warning', actionLabel: 'Review request' },
  { id: 'failed', title: 'One test needs attention', description: 'The last attempt produced a failure report.', time: '3 minutes ago', unread: true, tone: 'danger', actionLabel: 'Inspect failure' },
  { id: 'ready', title: 'Review artifacts are ready', description: 'The patch and run report are available.', time: '12 minutes ago', unread: false, tone: 'success' },
]
