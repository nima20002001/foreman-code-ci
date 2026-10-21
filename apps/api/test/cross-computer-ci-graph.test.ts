import { describe, expect, it } from 'vitest'
import { CiRunInputSchema } from '@foreman-code/contracts'
import * as scenario from './helpers/crossComputerCiGraph.js'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { buildCrossComputerCiGraph, projectSuites, type ScenarioAgent } from './helpers/crossComputerCiGraph.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const base: WorkflowDefinitionV3 = {
  id: 'workflow', workspaceId: 'workspace', name: 'CI', executionSemanticsVersion: 3,
  entryNodeId: null, executionCondition: { kind: 'manual' }, nodes: [], edges: [],
}
function assignment(index: number, suite: ScenarioAgent['suite']): ScenarioAgent {
  return {
    agentId: `agent-${index}`, nodeId: `node-${index}`, name: `Agent ${index}`, suite,
    ...(suite ? { task: { scope: 'affected' as const, files: ['apps/api/test/example.test.ts'],
      change: 'Add and test a label helper.', seedFailure: false } } : {}),
    profile: {
      instanceId: '22222222-2222-4222-8222-222222222222', instanceRevision: '1',
      target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
        harnessInstallationId: 'codex', installationFingerprint: 'codex-installed' },
    },
  }
}

describe('cross-computer CI graph', () => {
  it('enforces judgments without copied identifiers in the Agent output schema', () => {
    const { graph } = buildCrossComputerCiGraph(base, [assignment(0, null), assignment(1, 'typecheck')])
    const node = graph.nodes[1]!
    if (node.kind === 'job') throw new Error('Expected a CI Agent')
    expect(node.outputSchema).toMatchObject({
      required: ['suite', 'outcome', 'repository', 'logLine', 'observedStates'],
      additionalProperties: false,
    })
    expect(node.outputSchema?.properties).not.toHaveProperty('ticketId')
    expect(node.initialPrompt).toContain('group-terminal')
    expect(node.initialPrompt).toContain('logTail false')
    expect(node.initialPrompt).toContain('ci_logs_read')
    expect(node.initialPrompt).toContain('apps/api/test/example.test.ts')
    expect(node.initialPrompt).toContain('git commit')
    expect(node.initialPrompt).not.toContain('Do not edit or commit')
  })

  it.each(['graphql', 'demo'] as const)('starts every %s suite as an independent parallel Agent', project => {
    const assignments = [assignment(0, null), ...projectSuites[project].map((suite, index) => assignment(index + 1, suite))]
    const { graph, agents } = buildCrossComputerCiGraph(base, assignments)
    expect(graph.entryNodeId).toBe('node-0')
    expect(graph.executionPolicy).toEqual({ maxParallelism: 3, maxNodeExecutions: 4,
      agentActiveTimeoutMs: 4 * 60 * 60_000 })
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['node-0', 'node-1'], ['node-0', 'node-2'], ['node-0', 'node-3'],
    ])
    expect(graph.nodes.map(node => node.kind === 'job' ? null : node.agentId)).toEqual(agents.map(agent => agent.id))
    expect(graph).not.toHaveProperty('repeat')
    for (const agent of agents) {
      expect(agent.harnessConfiguration).toMatchObject({ harness: 'codex', sandbox: 'workspace-write',
        model: 'gpt-6.1-sol', reasoningEffort: 'medium', advanced: {
          approvalPolicy: 'never', additionalWritableDirectories: [], workspaceWrite: { networkAccess: true },
        } })
      expect(agent.graphqlTools).toEqual(expect.arrayContaining(['context_get', 'ci_computers_list', 'ci_run',
        'ci_get', 'ci_logs_read']))
    }
    expect(base.nodes).toEqual([])
  })

  it('retains the selected computer and workspace root for every Agent', () => {
    const worker = assignment(1, 'typecheck')
    worker.placement = {
      schemaVersion: 1, hostRef: { kind: 'device', mainId, deviceId: '33333333-3333-4333-8333-333333333333' },
      rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '5', projectRoot: '/approved/project',
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: worker.profile.instanceId,
      instanceRevision: worker.profile.instanceRevision, harnessInstallationId: 'codex',
    }
    const { graph } = buildCrossComputerCiGraph(base, [assignment(0, null), worker])
    const node = graph.nodes[1]!
    expect(node.kind === 'job' ? null : node.placement).toEqual(worker.placement)
  })

  it('rejects an empty, duplicate or non-coordinator entry assignment', () => {
    expect(() => buildCrossComputerCiGraph(base, [])).toThrow('entry coordinator')
    expect(() => buildCrossComputerCiGraph(base, [assignment(0, 'typecheck'), assignment(1, 'lint')]))
      .toThrow('entry coordinator')
    expect(() => buildCrossComputerCiGraph(base, [assignment(0, null), assignment(0, 'typecheck')]))
      .toThrow('separate Agent and node identity')
  })
})


it('plans twelve initial requests, one full integration burst and one seeded file retry per round', () => {
  const tasks = (['graphql', 'demo'] as const).flatMap(project => [1, 2].flatMap(index =>
    scenario.createCiTasks(project, index, `workflow-${index}`).map(task => ({ project, ...task }))))
  expect(tasks).toHaveLength(12)
  expect(tasks.filter(value => value.suite === 'integration' && value.task.scope === 'full')).toMatchObject([
    { project: 'graphql', suite: 'integration' },
  ])
  expect(tasks.filter(value => value.task.seedFailure)).toMatchObject([
    { project: 'demo', suite: 'unit', task: { scope: 'full' } },
  ])
  expect(tasks.filter(value => value.project === 'demo')).toHaveLength(6)
  for (const { suite, task } of tasks.filter(value => value.project === 'demo')) {
    expect(suite).toBe('unit')
    expect(task.scope).toBe('full')
    expect(task.files[0]).toMatch(/^test\/ci-scratch-[a-z-]+-workflow-[12]\.test\.mjs$/)
  }
  for (const { suite, task } of tasks) {
    expect(task.files).toHaveLength(1)
    expect(CiRunInputSchema.safeParse({ suite, scope: task.scope, commit: 'b'.repeat(40),
      ...(task.scope === 'affected' ? { files: task.files } : {}) }).success).toBe(true)
    expect(task.change.length).toBeGreaterThan(10)
  }
  for (const project of ['graphql', 'demo']) {
    const files = tasks.filter(value => value.project === project).flatMap(value => value.task.files)
    expect(new Set(files).size).toBe(6)
  }
})

it('uses fresh scratch paths in each workflow so later rounds execute their own tests', () => {
  const first = scenario.createCiTasks('demo', 1, 'workflow-first').flatMap(value => value.task.files)
  const second = scenario.createCiTasks('demo', 1, 'workflow-second').flatMap(value => value.task.files)
  expect(first.some(file => second.includes(file))).toBe(false)
})

it('keeps graphql retry instructions limited to failed files and the final request lifecycle', () => {
  const worker = assignment(1, 'integration')
  worker.task!.seedFailure = true
  const { graph } = buildCrossComputerCiGraph(base, [assignment(0, null), worker])
  const node = graph.nodes[1]!
  if (node.kind === 'job') throw new Error('Expected a CI Agent')
  expect(node.initialPrompt).toContain('testStatus ["failed"]')
  expect(node.initialPrompt).toContain('failed files')
  expect(node.initialPrompt).toContain('scope affected')
  expect(node.initialPrompt).toContain('deliberately')
  expect(node.initialPrompt).toContain('final request')
})


it.each([1, 2])('gives demo Agents executable node tests and full-suite retries in workflow %s', workflowIndex => {
  const tasks = scenario.createCiTasks('demo', workflowIndex, `workflow-${workflowIndex}`)
  const workers = tasks.map(({ suite, task }, index) => ({ ...assignment(index + 1, suite), task }))
  const { graph } = buildCrossComputerCiGraph(base, [assignment(0, null), ...workers])
  for (const node of graph.nodes.slice(1)) {
    if (node.kind === 'job') throw new Error('Expected a CI Agent')
    expect(node.initialPrompt).toContain('node:test')
    expect(node.initialPrompt).toContain('node:assert')
    expect(node.initialPrompt).toContain('scope full, omit files')
    expect(node.initialPrompt).toContain('rerun suite unit with scope full, omit files')
    expect(node.initialPrompt).not.toContain('Vitest')
    expect(node.initialPrompt).not.toContain('scope affected')
    expect(node.initialPrompt).not.toContain('full integration burst')
  }
  const seeded = graph.nodes[1]!
  if (seeded.kind === 'job') throw new Error('Expected a CI Agent')
  expect(!!seeded.initialPrompt?.includes('deliberately implement trim-only')).toBe(workflowIndex === 1)
})
