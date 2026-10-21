import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { readNodePlacement } from './client'
import { acceptedPlacementFixture as placement } from './fixtures'

const route = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/nodes/:nodeId/placement'
const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', nodeId: 'node-a' }
const response = { ...scope, readback: { evidence: 'accepted', placement, observations: [] } }
it('reads scoped placement through the authenticated HTTP boundary', async () => {
  let request: Request | undefined
  server.use(http.get(route, ({ request: observed }) => { request = observed; return HttpResponse.json(response) }))
  expect((await readNodePlacement(scope)).readback.evidence).toBe('accepted')
  expect(request?.credentials).toBe('omit')
})
it.each(['workspaceId', 'workflowId', 'runId', 'nodeId'] as const)('rejects a response for a different %s', async (field) => {
  server.use(http.get(route, () => HttpResponse.json({ ...response, [field]: 'other' })))
  await expect(readNodePlacement(scope)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
it('rejects accepted placement nested under another node envelope', async () => {
  server.use(http.get(route, () => HttpResponse.json({ ...response, readback: { ...response.readback, placement: { ...placement, nodeId: 'other' } } })))
  await expect(readNodePlacement(scope)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
it.each([401, 403, 404])('preserves access status %s', async (status) => {
  server.use(http.get(route, () => HttpResponse.json({ error: { code: 'DENIED', message: 'Unavailable' } }, { status })))
  await expect(readNodePlacement(scope)).rejects.toMatchObject({ status })
})

it('reads authorized choices for the exact saved configuration and rejects a newer substitution', async () => {
  const { readPlacementChoices } = await import('./client')
  const input = { workspaceId: scope.workspaceId, workflowId: scope.workflowId, nodeId: scope.nodeId, agentConfigurationVersionId: 'configuration-old' }
  const choicesRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/nodes/:nodeId/placement-choices'
  let observed: Request | undefined
  server.use(http.get(choicesRoute, ({ request }) => { observed = request; return HttpResponse.json({ ...input, pending: false, choices: [] }) }))
  expect((await readPlacementChoices(input)).choices).toEqual([])
  expect(new URL(observed!.url).searchParams.get('agentConfigurationVersionId')).toBe('configuration-old')
  server.use(http.get(choicesRoute, () => HttpResponse.json({ ...input, agentConfigurationVersionId: 'configuration-new', pending: false, choices: [] })))
  await expect(readPlacementChoices(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
