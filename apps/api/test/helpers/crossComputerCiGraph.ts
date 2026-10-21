import { AgentSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION, type Agent } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { WorkflowDefinitionV3Schema, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'

export const ciHarness = {
  harness: 'codex' as const,
  model: 'gpt-6.1-sol',
  reasoningEffort: 'medium' as const,
  serviceTier: 'standard' as const,
  // Writable Agents receive their own product-managed git worktree and branch.
  sandbox: 'workspace-write' as const,
  advanced: {
    ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
    workspaceWrite: { networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
}

export const projectSuites = {
  graphql: ['typecheck', 'lint', 'integration'],
  demo: ['unit', 'unit', 'unit'],
} as const
export type ScenarioProject = keyof typeof projectSuites
export type ScenarioSuite = (typeof projectSuites)[ScenarioProject][number]

export type ScenarioTask = {
  scope: 'affected' | 'full'
  files: string[]
  change: string
  seedFailure: boolean
}

export type ScenarioAgent = {
  nodeId: string
  agentId: string
  name: string
  suite: ScenarioSuite | null
  task?: ScenarioTask
  profile: HarnessProfileSelection
  placement?: SavedNodePlacement
}

export function createCiTasks(project: ScenarioProject, workflowIndex: number, workflowId: string) {
  const changes = [
    { name: 'normalize-label', change: 'Implement normalizeLabel: trim and collapse whitespace; test empty and spaced labels.' },
    { name: 'sum-line-items', change: 'Implement sumLineItems: sum quantity times price; test empty and multiple items.' },
    { name: 'clamp-percentage', change: 'Implement clampPercentage: clamp to 0..100; test below, within and above bounds.' },
  ]
  return projectSuites[project].map((suite, index) => {
    const change = changes[index]!
    const suffix = suite === 'integration' ? '.integration.test.ts' : '.test.ts'
    const task: ScenarioTask = {
      scope: project === 'demo' || suite === 'integration' && workflowIndex === 1 ? 'full' : 'affected',
      files: [project === 'demo' ? `test/ci-scratch-${change.name}-${workflowId}.test.mjs`
        : `apps/api/test/ci-scratch-${change.name}-${workflowId}${suffix}`],
      change: change.change,
      seedFailure: project === 'demo' && workflowIndex === 1 && index === 0,
    }
    return { suite, task }
  })
}

const terminalOutcome = { enum: ['passed', 'failed', 'canceled', 'lost'] }

/** The app enforces the judgments; identifiers come from product readback. */
export function ciReportOutputSchema(suite: ScenarioSuite) {
  return {
    type: 'object',
    required: ['suite', 'outcome', 'repository', 'logLine', 'observedStates'],
    additionalProperties: false,
    properties: {
      suite: { const: suite },
      outcome: terminalOutcome,
      repository: { type: 'string', minLength: 1 },
      logLine: { type: 'string', minLength: 1 },
      observedStates: { type: 'array', minItems: 1, items: { type: 'string' } },
    },
  }
}

function agentPrompt({ suite, task }: ScenarioAgent): string {
  if (suite === null) {
    return 'Use context_get to read your own worktree and branch, then finish successfully with a short ready message. '
      + 'The workflow will then start all CI Agents in parallel. Do not request CI or change files.'
  }
  if (!task) throw new Error('Every suite Agent needs a file change and CI task.')
  const demo = suite === 'unit'
  let selection = `scope affected, files ${JSON.stringify(task.files)}`
  if (task.scope === 'full') {
    selection = 'scope full, omit files'
    if (suite === 'integration') selection += ' (the round’s only full integration burst)'
  }
  const testFramework = demo ? 'node:test file using node:assert/strict' : 'Vitest file'
  const seed = task.seedFailure
    ? 'In your first commit deliberately implement trim-only, keeping the collapse-whitespace test correct. '
    : ''
  const retry = demo
    ? 'If CI fails, read the failed ticket logs and test results, fix only your own helper/test, commit and push, '
      + 'then rerun suite unit with scope full, omit files, current published HEAD and a new commandId. '
      + 'This repository has no affected test selection. Wait for that group the same way. '
    : 'If parts fail, read each failed ticket once with ci_get testStatus ["failed"]; union its failed files from tests.files. '
      + 'For lint/typecheck without structured results use the failed run.files; if no failed files are available, report failure. '
      + 'Fix only your own helper/test if needed, commit and push changes. Rerun ONLY those failed files with scope affected, '
      + 'the same suite, current published HEAD and a new commandId; never rerun a whole suite. Wait for that group the same way. '
  return 'Read context_get and ci_computers_list. Use native tools in your assigned product-managed worktree/branch; '
    + 'do not create another worktree or switch branches. '
    + `Change only ${JSON.stringify(task.files)}: add a self-contained ${testFramework} with the helper and tests. ${task.change} `
    + 'Do not change product code, existing tests or configuration. '
    + seed
    + 'Use git add for only that file, git commit, then git push origin HEAD to publish only your Agent branch. '
    + `Call ci_run for suite ${suite}, ${selection}, commit = git rev-parse HEAD and a fresh commandId. `
    + 'For an uncertain response retry the same commandId and identical arguments. '
    + 'Placement is automatic: do not supply a computer or placementOverride. '
    + 'Wait with ONE ci_get call on any ticket: waitUntil "group-terminal", waitSeconds 1800 and logTail false. '
    + 'Repeat that same call only while its wait.status is still-running; do not poll tickets one by one. '
    + 'When wait.status is settled, its partitions (or run, for a single ticket) hold every ticket’s final state. '
    + retry
    + 'Repeat only after observed failures; do not retry canceled/lost work or request CI after a passed group. '
    + 'Report the final request only: record its top-level ticket’s observed states in order, then read ci_logs_read '
    + 'for that ticket and choose one nonempty line. '
    + 'Report only observed facts. Your final answer must be one JSON object, without markdown: '
    + '{"suite":"' + suite + '",'
    + '"outcome":"group.state","repository":"run.repository",'
    + '"logLine":"actual line from the top-level ticket log",'
    + '"observedStates":["queued","passed"]}. '
    + 'Include only states you observed; starting and running may be missed. '
    + 'Do not copy ticket IDs, group IDs or branch names into your report. '
    + 'Repository is the owner/repository string from run.repository. '
    + 'If CI cannot pass, report its actual outcome.'
}

export function buildCrossComputerCiGraph(
  base: WorkflowDefinitionV3,
  assignments: readonly ScenarioAgent[],
): { graph: WorkflowDefinitionV3; agents: Agent[] } {
  const coordinator = assignments[0]
  if (!coordinator || coordinator.suite !== null || assignments.length < 2) {
    throw new Error('A CI workflow needs one entry coordinator followed by suite Agents.')
  }
  if (assignments.slice(1).some(agent => agent.suite === null)) {
    throw new Error('Only the entry coordinator may omit its suite.')
  }
  if (new Set(assignments.map(agent => agent.agentId)).size !== assignments.length
    || new Set(assignments.map(agent => agent.nodeId)).size !== assignments.length) {
    throw new Error('Every CI Agent needs a separate Agent and node identity.')
  }
  const agents = assignments.map(assignment => AgentSchema.parse({
    id: assignment.agentId,
    name: assignment.name,
    productRole: 'coder',
    harness: ciHarness.harness,
    model: ciHarness.model,
    harnessConfiguration: ciHarness,
    harnessProfileSelection: assignment.profile,
    prompt: { system: 'Complete the assigned MCP task and report observed results accurately.' },
    assignedSkills: [],
    graphqlTools: ['context_get', 'ci_computers_list', 'ci_run', 'ci_get', 'ci_cancel',
      'ci_logs_read'],
  }))
  const graph = WorkflowDefinitionV3Schema.parse({
    ...base,
    entryNodeId: coordinator.nodeId,
    requiredAgentCount: assignments.length,
    approval: { handler: 'user' },
    executionPolicy: { maxParallelism: assignments.length - 1, maxNodeExecutions: assignments.length,
      agentActiveTimeoutMs: 4 * 60 * 60_000 },
    nodes: assignments.map((assignment, index) => ({
      id: assignment.nodeId,
      agentId: assignment.agentId,
      name: assignment.name,
      initialPrompt: agentPrompt(assignment),
      ...(assignment.suite ? { outputSchema: ciReportOutputSchema(assignment.suite) } : {}),
      position: { x: index === 0 ? 0 : 320, y: index * 180 },
      ...(assignment.placement ? { placement: assignment.placement } : {}),
    })),
    edges: assignments.slice(1).map(assignment => ({
      id: `${coordinator.nodeId}-${assignment.nodeId}`,
      source: coordinator.nodeId,
      target: assignment.nodeId,
      kind: 'execution',
    })),
  })
  return { graph, agents }
}
