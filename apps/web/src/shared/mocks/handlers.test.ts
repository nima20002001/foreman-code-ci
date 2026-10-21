import { afterEach, describe, expect, it } from 'vitest'

import { apiClient } from '../api'
import {
  getMockFixture,
  updateMockWorkflow,
  setMockScenario,
} from './scenarios'

describe('deterministic mock scenarios', () => {
  afterEach(() => setMockScenario('normal'))

  it('exposes named browser profiles and the operator holder while waiting', async () => {
    setMockScenario('waiting-browser')
    const details = await apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })

    expect(details.browserProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'GitHub', status: 'in_use', resourceHolder: 'operator' }),
        expect.objectContaining({ name: 'Website Admin', status: 'available' }),
      ]),
    )
    expect(details.runs[0]).toMatchObject({
      executionState: 'waiting',
      browserWait: {
        reason: 'browser_profile',
        resourceHolder: 'operator',
        resourceName: 'GitHub',
        holderId: 'agent-operator',
        holderLabel: 'Operator',
        executionId: 'run-1',
      },
    })
    expect(details.agents.find((agent) => agent.name === 'Researcher')).toMatchObject({ activeRunId: 'run-1' })
  })

  it('resets fixture mutations when selecting a new scenario', async () => {
    const details = await apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })
    const current = details.workflows[0]
    if (!current) throw new Error('fixture workflow missing')
    updateMockWorkflow('workspace-1', { ...current, name: 'Temporary' })
    setMockScenario('normal')

    const reset = await apiClient.getWorkflow({ workspaceId: 'workspace-1', workflowId: current.id })
    expect(reset.workflow.name).toBe('Research to review')
  })

  it('provides explicit auth, disconnected-runner, empty and error controls', async () => {
    setMockScenario('auth-required')
    const auth = await apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })
    expect(auth.runs[0]).toMatchObject({ authRequired: true, browserWait: { reason: 'auth_required' } })

    setMockScenario('runner-disconnected')
    const disconnected = await apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })
    expect(disconnected.runners?.[0]?.health.status).toBe('disconnected')

    setMockScenario('empty')
    const empty = await apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })
    expect(empty.workflows).toEqual([])

    setMockScenario('error')
    await expect(apiClient.listVisibleResources({ workspaceId: 'workspace-1' })).rejects.toMatchObject({
      code: 'MOCK_READ_FAILED',
    })
  })

  it('uses activeRunId for the active agent and keeps harness summaries neutral', () => {
    const cases = [
      ['working', 'Researcher'],
      ['waiting-browser', 'Researcher'],
      ['auth-required', 'Operator'],
      ['interrupted', 'Developer'],
      ['runner-disconnected', 'Developer'],
    ] as const

    for (const [scenario, activeAgentName] of cases) {
      setMockScenario(scenario)
      const fixture = getMockFixture('workspace-1')
      if (!fixture) throw new Error('fixture workspace missing')
      const activeAgent = fixture.agents.find((agent) => agent.name === activeAgentName)
      expect(activeAgent).toMatchObject({ activeRunId: 'run-1' })
      expect(activeAgent?.harnessSummary).not.toMatchObject({ status: 'running' })
      expect(activeAgent?.harnessSummary?.detail).not.toBe('GitHub')
      expect(activeAgent?.harnessSummary?.detail).not.toBe('Website Admin')
    }
  })

  it('returns 404 for foreign workspace reads and mutations without rewriting fixture state', async () => {
    const foreignWorkspaceId = 'workspace-foreign'
    const foreignError = { code: 'WORKSPACE_NOT_FOUND', status: 404 }

    await expect(apiClient.getWorkspaceDetails({ workspaceId: foreignWorkspaceId })).rejects.toMatchObject(foreignError)
    await expect(apiClient.listAgents({ workspaceId: foreignWorkspaceId })).rejects.toMatchObject(foreignError)
    await expect(apiClient.listVisibleResources({ workspaceId: foreignWorkspaceId })).rejects.toMatchObject(foreignError)
    await expect(
      apiClient.getWorkflow({ workspaceId: foreignWorkspaceId, workflowId: 'workflow-content-pipeline' }),
    ).rejects.toMatchObject(foreignError)

    const current = (await apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })).workflows[0]
    if (!current) throw new Error('fixture workflow missing')
    await expect(
      apiClient.createManagedWorkflow({ workspaceId: foreignWorkspaceId, name: 'Foreign mutation', commandId: 'foreign-create' }),
    ).rejects.toMatchObject(foreignError)

    const unchanged = await apiClient.getWorkflow({ workspaceId: 'workspace-1', workflowId: current.id })
    expect(unchanged.workflow.name).toBe('Research to review')
  })
})
