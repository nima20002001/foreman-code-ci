import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOperatorChatSettings, operatorChatSettings, DEFAULT_HARNESS_DEFAULTS, AgentSchema, type Agent } from '@foreman-code/contracts'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { AgentUpdateInputSchema, type AgentUpdateInput } from '@foreman-code/contracts/management'
import { server } from '../../../mocks/server'
import { agentChatTestActions } from '../../../shared/mocks/agentChatHandlers'
import { defaultAgentForHarness } from '../../agents/agentSettings'
import { savedClaudeConfiguration } from '../../settings/claudeSettings.fixtures'
import { installChatSource, mountChat } from './testSupport'

const codex = DEFAULT_HARNESS_DEFAULTS.codex
vi.mock('../../provider-accounts/useProviderHarnessModels', () => ({
  useProviderHarnessModels: () => ({
    data: { models: [{ id: 'gpt-fixture', name: 'GPT Fixture', variants: [], reasoningEfforts: ['low', 'medium', 'high'], serviceTiers: ['standard', 'priority'] }] },
    isSuccess: true, isPending: false, isError: false,
  }),
}))

let agent: Agent
let revision: number
let updates: AgentUpdateInput[]
function idleChat(): AgentChatState {
  return { ...structuredClone(agentChatFixtures.active), sessionState: 'idle', activeTurn: null, turns: [], messages: [], activities: [],
    availability: { canSend: true }, revision: 1 }
}
beforeEach(() => {
  installChatSource()
  revision = 4; updates = []
  agent = AgentSchema.parse({ ...defaultAgentForHarness('codex', 'agent-coder', 'Coder', { ...codex, model: 'gpt-fixture', reasoningEffort: 'medium' }, 'coder'),
    configurationVersionId: 'agent-config-fixture' })
  server.use(
    http.get('/api/management/workspaces/:workspaceId/agents', () =>
      HttpResponse.json({ items: [{ agent, metadataRevision: revision }], pageInfo: { nextCursor: null } })),
    http.patch('/api/management/workspaces/:workspaceId/agents/:agentId', async ({ request, params }) => {
      const input = AgentUpdateInputSchema.parse({ ...(await request.json() as object), workspaceId: params.workspaceId, agentId: params.agentId })
      updates.push(input)
      agent = AgentSchema.parse({ ...agent, harnessConfiguration: input.configuration, effort: input.configuration && 'reasoningEffort' in input.configuration ? input.configuration.reasoningEffort : agent.effort,
        configurationVersionId: 'agent-config-saved' })
      revision += 1
      return HttpResponse.json({ value: { agent, metadataRevision: revision }, replayed: false })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('Agent settings in the Agent chat window', () => {
  it.each([codex, savedClaudeConfiguration])('produces a supported $harness Agent edit without changing execution settings', base => {
    const configuration: AgentUpdateInput['configuration'] = applyOperatorChatSettings(base, operatorChatSettings(base))

    expect(configuration).toStrictEqual(base)
  })

  it('saves a new Agent configuration version when the reasoning effort is changed from the chat', async () => {
    const view = mountChat(idleChat(), [...agentChatTestActions, 'agents:update'])
    await view.ready()
    const trigger = await screen.findByRole('button', { name: 'Agent settings: GPT Fixture, medium' })
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.setup().click(trigger)
    expect(screen.queryByRole('switch', { name: 'Show thinking' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('slider', { name: 'Effort' }), { target: { value: '2' } })
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({ workspaceId: 'workspace-fixture', agentId: 'agent-coder', expectedRevision: 4,
      expectedConfigurationVersionId: 'agent-config-fixture', configuration: { harness: 'codex', model: 'gpt-fixture', reasoningEffort: 'high' } })
    expect(await screen.findByRole('button', { name: 'Agent settings: GPT Fixture, high' })).toBeInTheDocument()
    expect(screen.queryByText(/keeps the settings it started with/)).not.toBeInTheDocument()
  })

  it('does not let a caller without Agent edit access change the settings', async () => {
    const view = mountChat(idleChat())
    await view.ready()
    const trigger = await screen.findByRole('button', { name: 'Agent settings: GPT Fixture, medium' })
    expect(trigger).toBeDisabled()
    expect(updates).toEqual([])
  })
})
