import { http, HttpResponse } from 'msw'
import { DEFAULT_REMOTE_EXECUTION_SETTINGS, LocalHumanAccessSchema, DEFAULT_WORKSPACE_DEFAULTS, ManagedWorkspaceDefaultsSchema,
  WorkspaceDefaultsUpdateInputSchema, WorkspaceDefaultsUpdateResultSchema } from '@foreman-code/contracts/management'
import { getMockScenarioState } from './scenarios'
import { ProviderAccountsSnapshotSchema } from '@foreman-code/contracts/provider-accounts'

// Development/test fixtures only. These handlers do not create or authenticate real credentials.
let defaults = ManagedWorkspaceDefaultsSchema.parse({ value: { ...DEFAULT_WORKSPACE_DEFAULTS, parentPath: '/home/test/.local/share/graphql/workspaces' }, revision: 0, versionId: null })
const receipts = new Map<string, { input: string; result: typeof defaults }>()
export function getMockWorkspaceCreationDefaults() { return defaults.value }
export function resetSettingsExperienceFixtures() {
  defaults = ManagedWorkspaceDefaultsSchema.parse({ value: { ...DEFAULT_WORKSPACE_DEFAULTS, parentPath: '/home/test/.local/share/graphql/workspaces' }, revision: 0, versionId: null })
  receipts.clear()
}
function failure() {
  return getMockScenarioState().scenarioId === 'error'
    ? HttpResponse.json({ error: { code: 'MOCK_READ_FAILED', message: 'The selected mock scenario fails read requests.' } }, { status: 503 }) : undefined
}
export const settingsExperienceHandlers = [
  http.get('/api/management/settings/remote-execution', () => failure() ?? HttpResponse.json({
    value: DEFAULT_REMOTE_EXECUTION_SETTINGS, revision: 0, versionId: null,
    effective: DEFAULT_REMOTE_EXECUTION_SETTINGS, environmentOverrides: [],
    runtime: { listenerEnabled: false, listenerEndpoint: null, restartRequired: false, reason: null },
  })),
  http.get('/api/provider-accounts', () => failure() ?? HttpResponse.json(
    ProviderAccountsSnapshotSchema.parse({ revision: 0, accounts: [] }),
  )),
  http.get('/api/management/settings/workspaces', () => failure() ?? HttpResponse.json(defaults)),
  http.get('/api/management/settings/workspaces/creation', () => failure() ?? HttpResponse.json(defaults.value)),
  http.put('/api/management/settings/workspaces', async ({ request }) => {
    const error = failure(); if (error) return error
    const input = WorkspaceDefaultsUpdateInputSchema.safeParse(await request.json())
    if (!input.success) return HttpResponse.json({ error: { code: 'INVALID_REQUEST', message: 'Review the workspace defaults.' } }, { status: 400 })
    const payload = JSON.stringify(input.data)
    const previous = receipts.get(input.data.commandId)
    if (previous) return previous.input === payload
      ? HttpResponse.json(WorkspaceDefaultsUpdateResultSchema.parse({ value: previous.result, replayed: true }))
      : HttpResponse.json({ error: { code: 'COMMAND_ID_CONFLICT', message: 'Command ID already used with different input.' } }, { status: 409 })
    if (input.data.expectedRevision !== defaults.revision) return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Workspace defaults changed.' } }, { status: 409 })
    defaults = ManagedWorkspaceDefaultsSchema.parse({ value: input.data.value, revision: defaults.revision + 1, versionId: `mock-workspaces-${defaults.revision + 1}` })
    receipts.set(input.data.commandId, { input: payload, result: structuredClone(defaults) })
    return HttpResponse.json(WorkspaceDefaultsUpdateResultSchema.parse({ value: defaults, replayed: false }))
  }),
  http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
    id: 'principal-preview', name: 'Preview browser (simulated)', expiresAt: '2099-01-01T00:00:00Z',
    grants: [{ actions: ['settings:read', 'harnesses:read'], scope: {} }],
  } }), { headers: { 'Cache-Control': 'no-store' } })),
]
