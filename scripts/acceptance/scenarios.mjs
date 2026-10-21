import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { APP_MCP_SERVER_NAMES, APP_MCP_TOKEN_NAMES } from '../../packages/contracts/dist/product.js'

export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'
const COMMON = 'This is an isolated acceptance demo. Use only accepted workflow inputs. Do not read secrets, credentials, home directories or external services. Do not change files. Follow the node instruction exactly.'
export function configuration(kind, { codexModel, approval = false, claudeConfigDirectory, appMcpUrl }) {
  if (kind === 'codex') return {
    harness: 'codex', model: codexModel, reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard',
    advanced: { approvalPolicy: 'on-request', approvalsReviewer: 'user', additionalWritableDirectories: [],
      sessionPersistence: 'persistent', shellEnvironment: { inherit: 'core', ignoreDefaultExcludes: false, filters: {}, set: {} },
      webSearch: 'disabled', mcpServers: {} },
  }
  return { harness: 'claude', model: CLAUDE_MODEL, authMode: 'subscription',
    configDirectory: claudeConfigDirectory, permissionMode: 'default', sandbox: 'danger-full-access',
    tools: approval ? ['Bash'] : [], permissionRules: approval ? [{ tool: 'Bash', effect: 'ask' }] : [],
    instructions: '', mcpServers: { [APP_MCP_SERVER_NAMES[0]]: { type: 'http', url: appMcpUrl } },
  }
}
export const SCENARIOS = [
  { key: 'S3-01', name: 'S3-01 Sequential', nodes: ['First', 'Second'], pairs: [[0, 1]], executions: 2 },
  { key: 'S3-02', name: 'S3-02 Parallel join', nodes: ['Fork', 'Left', 'Right', 'Join'], pairs: [[0, 1], [0, 2], [1, 3], [2, 3]], executions: 4, parallel: true },
  // Both branches selected, one deeper than the other: the all-required join must
  // wait for the deeper predecessor and then run exactly once.
  { key: 'S3-02-uneven', name: 'S3-02 Uneven parallel join', nodes: ['Fork', 'Short', 'Long one', 'Long two', 'Join'],
    pairs: [[0, 1], [0, 2], [2, 3], [1, 4], [3, 4]], executions: 5, parallel: true },
  { key: 'S3-03-short', name: 'S3-03 Uneven join short', nodes: ['Route', 'Short', 'Long one', 'Long two', 'Join'],
    pairs: [[0, 1], [0, 2], [2, 3], [1, 4], [3, 4]], executions: 3, route: 'short' },
  { key: 'S3-03-long', name: 'S3-03 Uneven join long', nodes: ['Route', 'Short', 'Long one', 'Long two', 'Join'],
    pairs: [[0, 1], [0, 2], [2, 3], [1, 4], [3, 4]], executions: 4, route: 'long' },
  { key: 'S3-04', name: 'S3-04 Human approval', nodes: ['Permission', 'After approval'], pairs: [[0, 1]], executions: 2, approval: true },
  { key: 'S3-05-early', name: 'S3-05 Repeat early', nodes: ['Deliver', 'Decide'], pairs: [[0, 1]], executions: 2, repeat: 'early' },
  { key: 'S3-05-limit', name: 'S3-05 Repeat limit', nodes: ['Deliver', 'Decide'], pairs: [[0, 1]], executions: 6, repeat: 'limit' },
]
export function scenarioGraph(spec, workflow, { codexModel, claudeConfigDirectory, appMcpUrl }) {
  const agents = spec.nodes.map((name, i) => {
    const harness = codexModel && spec.key === 'S3-02' && i === 2 ? 'codex' : 'claude'
    const cfg = configuration(harness, { codexModel, approval: spec.approval && i === 0,
      claudeConfigDirectory, appMcpUrl })
    return { baseRevision: null, agent: { id: `agent-${randomUUID()}`, name: `${spec.key} ${name}`,
      productRole: i === 0 ? 'orchestrator' : 'coder', harness: cfg.harness, model: cfg.model,
      harnessConfiguration: cfg, prompt: { system: COMMON }, assignedSkills: [] } }
  })
  const nodes = spec.nodes.map((name, i) => ({ id: `node-${randomUUID()}`, agentId: agents[i].agent.id, name,
    position: { x: i * 280, y: i % 2 * 200 },
    initialPrompt: `Do not use tools. Return exactly the text ENG07_${spec.key}_${i}.` }))
  const edges = spec.pairs.map(([from, to]) => ({ id: `edge-${randomUUID()}`, kind: 'execution', source: nodes[from].id, target: nodes[to].id }))
  if (spec.parallel || spec.route) nodes.at(-1).join = { mode: 'all' }
  if (spec.key === 'S3-02') for (const i of [1, 2]) nodes[i].initialPrompt = `Do not use tools. Output twenty short numbered lines explaining the number ${i}, then ENG07_${spec.key}_${i}.`
  if (spec.route) {
    nodes[0].choice = { outcomes: ['short', 'long'].map((outcome, i) => ({ outcome, target: { kind: 'edge', relationshipId: edges[i].id } })) }
    nodes[0].initialPrompt = `Do not use tools. Return exactly {"routing":{"outcome":"${spec.route}"},"data":{"marker":"ENG07_${spec.route}"}}.`
  }
  if (spec.approval) nodes[0].initialPrompt = 'Use the native Bash tool exactly once with command printf ENG07_APPROVED. Let the native permission request be routed to the human. Do not substitute another command, tool or a textual claim of approval. After approval and successful command completion, return ENG07_APPROVED.'
  if (spec.repeat) {
    nodes[1].choice = { outcomes: ['pass', 'issues'].map((outcome) => ({ outcome, target: { kind: 'branch_end' } })) }
    const outcome = spec.repeat === 'early' ? 'pass' : 'issues'
    nodes[1].initialPrompt = `Do not use tools. Return exactly {"routing":{"outcome":"${outcome}"},"data":{"latestDeliverable":{"marker":"ENG07_${spec.repeat}"},"remainingFindings":${outcome === 'pass' ? '[]' : '["demo finding still open"]'}}}.`
  }
  const graph = { ...workflow, executionSemanticsVersion: 3, entryNodeId: nodes[0].id,
    approval: { handler: 'user' }, executionCondition: { kind: 'manual' },
    executionPolicy: { maxParallelism: spec.parallel ? 2 : 1, maxNodeExecutions: spec.repeat ? 6 : nodes.length }, nodes, edges }
  if (spec.repeat) {
    delete graph.handoffs
    graph.repeat = { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: nodes.map((node) => node.id),
      entryNodeId: nodes[0].id, exitNodeId: nodes[1].id, maxOccurrences: 3,
      repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] }
  }
  return { graph, agents }
}

export async function seed({ apiUrl, webUrl, projectRoot, codexModel, schemas,
  claudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR }) {
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${apiUrl}${path}`, { method,
      headers: { origin: webUrl, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}))
      throw Object.assign(new Error('Seed request failed; no automatic resubmission.'), {
        code: failure.error?.code, method, path, status: response.status, details: failure.error?.details,
      })
    }
    return response.json()
  }
  const workspace = (await request('/api/management/workspaces', 'POST', {
    commandId: randomUUID(), name: 'ENG07 Acceptance', description: 'Disposable isolated semantics-3 owner acceptance.', parentPath: projectRoot,
  })).value
  if (workspace.locationValidation.status !== 'ready' || !Number.isSafeInteger(workspace.locationRevision) || workspace.locationRevision < 0) throw new Error('Seed location was not accepted.')
  const folder = await realpath(workspace.executionLocation.rootPath)
  const suffix = relative(await realpath(projectRoot), folder)
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('Execution folder escaped task storage.')
  // The public template refers to a credential issued by the app for the native turn.
  if (codexModel) {
    await mkdir(join(folder, '.codex'), { mode: 0o700 })
    await writeFile(join(folder, '.codex/config.toml'),
      `[mcp_servers.${JSON.stringify(APP_MCP_SERVER_NAMES[0])}]\nurl = "${apiUrl}/mcp"\nbearer_token_env_var = "${APP_MCP_TOKEN_NAMES[0]}"\nenabled = true\n`,
      { mode: 0o600, flag: 'wx' })
  }
  const workspaceId = workspace.workspace.id
  const workflowIds = [], expectedAgents = new Map()
  for (const spec of SCENARIOS) {
    const created = (await request(`/api/management/workspaces/${workspaceId}/workflows`, 'POST', {
      commandId: randomUUID(), name: spec.name, executionSemanticsVersion: 3,
    })).value
    const { graph, agents } = scenarioGraph(spec, created.workflow,
      { codexModel, claudeConfigDirectory, appMcpUrl: `${apiUrl}/mcp` })
    for (const { agent } of agents) expectedAgents.set(agent.id, agent)
    const path = `/api/management/workspaces/${workspaceId}/workflows/${created.workflow.id}/definition`
    const draftId = `eng07-draft-${randomUUID()}`
    const stage = schemas.CurrentEditStageInputSchema.parse({ action: 'stage_edits', commandId: randomUUID(), draftId,
      workspaceId, workflowId: created.workflow.id, executionSemanticsVersion: 3,
      expectedRevision: created.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: {}, graph, stagedAgents: agents })
    await request(`${path}/edits`, 'POST', stage)
    // Read the authoritative intent, including its reserved advance command ID.
    const read = await request(`${path}/edits?draftId=${encodeURIComponent(draftId)}`)
    const intent = read.intent
    if (!intent || intent.affected.length !== 0) throw new Error('Unexpected active Run during first seed.')
    await request(`${path}/edits`, 'POST', { action: 'stop_and_save', workspaceId, workflowId: created.workflow.id,
      draftId, intentId: intent.id, commandId: intent.advanceCommandId })
    const saved = schemas.CurrentWorkflowReadResultSchema.parse(await request(path))
    if (saved.version.executionSemanticsVersion !== 3 || Boolean(saved.version.definition.repeat) !== Boolean(spec.repeat)
      || Object.keys(saved.version.agentConfigurationVersionIds).length !== agents.length) throw new Error('Seed publication did not match the scenario.')
    workflowIds.push({ key: spec.key, workflowId: created.workflow.id, workflowVersionId: saved.version.id })
  }
  // Read real persisted Agent projections, not only the Save response.
  const agents = await request(`/api/management/workspaces/${workspaceId}/agents?limit=100`)
  if (agents.items.length !== SCENARIOS.reduce((total, spec) => total + spec.nodes.length, 0)
    || agents.items.some(({ agent }) => !agent.configurationVersionId
      || agent.name !== expectedAgents.get(agent.id)?.name
      || agent.harness !== expectedAgents.get(agent.id)?.harness
      || agent.harnessConfiguration?.model !== expectedAgents.get(agent.id)?.harnessConfiguration.model)) throw new Error('Seed Agent readback failed.')
  return { workspaceId, workflowIds, executionFolder: workspace.executionLocation.rootPath, agentCount: agents.items.length }
}
