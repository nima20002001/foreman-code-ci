import { http, HttpResponse } from 'msw'
import {
  SkillArchiveInputSchema, SkillCreateInputSchema, SkillUpdateInputSchema,
  type SkillSummary, type SkillVersion,
} from '@foreman-code/contracts/management'

// Deterministic unit-test fixture for the Skills HTTP contract. The browser always uses the real API.
interface Stored { summary: SkillSummary; versions: SkillVersion[] }
let skills = new Map<string, Stored>()
let receipts = new Map<string, { input: string; result: unknown }>()
let sequence = 0
interface SkillUser { agentId: string; name: string; version: string; workflows: { workflowId: string; name: string }[] }
let users = new Map<string, SkillUser[]>()
const key = (workspaceId: string, skillId: string) => `${workspaceId}/${skillId}`
const now = () => new Date(Date.UTC(2026, 8, 27, 12, 0, sequence++)).toISOString()
const hash = (text: string) => `sha256:${Array.from(text).reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7).toString(16).padStart(64, '0')}`
const error = (code: string, message: string, status: number, details?: Record<string, unknown>) =>
  HttpResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status })

export function resetSkillFixtures() { skills = new Map(); receipts = new Map(); users = new Map(); sequence = 0 }
/** An Agent assigned a version of the skill, and the saved workflows that use it. */
export function assignSkillUser(workspaceId: string, skillId: string, user: SkillUser) {
  users.set(key(workspaceId, skillId), [...(users.get(key(workspaceId, skillId)) ?? []), user])
}
/** Seed one logical skill directly, as if saved earlier. */
export function seedSkill(workspaceId: string, name: string, instructions: string, options: { skillId?: string; description?: string; archived?: boolean } = {}): SkillSummary {
  const skillId = options.skillId ?? `skill-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const version: SkillVersion = { workspaceId, skillId, version: '1', name, ...(options.description ? { description: options.description } : {}),
    instructions, contentHash: hash(instructions), createdAt: now() }
  const summary: SkillSummary = { workspaceId, skillId, name, ...(options.description ? { description: options.description } : {}), version: '1',
    contentHash: version.contentHash, revision: 1, versionCount: 1, archived: Boolean(options.archived), createdAt: version.createdAt, updatedAt: version.createdAt }
  skills.set(key(workspaceId, skillId), { summary, versions: [version] })
  return summary
}
/** Simulates a save from another client (for example the Operator over MCP). */
export function editSkillElsewhere(workspaceId: string, skillId: string, instructions: string) {
  const stored = skills.get(key(workspaceId, skillId))!
  save(stored, { name: stored.summary.name, description: stored.summary.description, instructions })
}
function save(stored: Stored, content: { name: string; description?: string | undefined; instructions: string }) {
  const at = now()
  const version: SkillVersion = { workspaceId: stored.summary.workspaceId, skillId: stored.summary.skillId, version: String(stored.versions.length + 1),
    name: content.name, ...(content.description ? { description: content.description } : {}), instructions: content.instructions, contentHash: hash(content.instructions), createdAt: at }
  stored.versions.push(version)
  const rest = { ...stored.summary }; delete rest.description
  stored.summary = { ...rest, name: version.name, ...(version.description ? { description: version.description } : {}), version: version.version,
    contentHash: version.contentHash, revision: stored.summary.revision + 1, versionCount: stored.versions.length, updatedAt: at }
  return version
}
async function command(request: Request, run: (input: unknown) => Response | { skill: SkillSummary; version: SkillVersion; changed: boolean }) {
  const input = await request.json() as { commandId?: string }
  const receipt = input.commandId ? receipts.get(input.commandId) : undefined
  if (receipt) return receipt.input === JSON.stringify(input) ? HttpResponse.json({ value: receipt.result, replayed: true })
    : error('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
  const result = run(input)
  if (result instanceof Response) return result
  if (input.commandId) receipts.set(input.commandId, { input: JSON.stringify(input), result })
  return HttpResponse.json({ value: result, replayed: false }, { status: request.method === 'POST' ? 201 : 200 })
}

export const skillsHandlers = [
  http.get('/api/management/skills', ({ request }) => {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get('workspaceId'), query = url.searchParams.get('query')?.toLowerCase()
    const archived = url.searchParams.get('includeArchived') === 'true'
    const items = [...skills.values()].map((item) => item.summary)
      .filter((item) => (!workspaceId || item.workspaceId === workspaceId) && (archived || !item.archived)
        && (!query || item.name.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query)))
      .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()))
    return HttpResponse.json({ items, pageInfo: { nextCursor: null } })
  }),
  http.post('/api/management/workspaces/:workspaceId/skills', ({ request, params }) => command(request, (raw) => {
    const input = SkillCreateInputSchema.safeParse(raw)
    if (!input.success) return error('INVALID_REQUEST', 'The request does not match its shared contract.', 400)
    const summary = seedSkill(String(params.workspaceId), input.data.name, input.data.instructions,
      { skillId: `skill-${sequence}`, ...(input.data.description ? { description: input.data.description } : {}) })
    return { skill: summary, version: skills.get(key(summary.workspaceId, summary.skillId))!.versions[0]!, changed: true }
  })),
  http.get('/api/management/workspaces/:workspaceId/skills/:skillId', ({ request, params }) => {
    const stored = skills.get(key(String(params.workspaceId), String(params.skillId)))
    if (!stored) return error('SKILL_NOT_FOUND', 'The skill was not found.', 404)
    const wanted = new URL(request.url).searchParams.get('version') ?? stored.summary.version
    const version = stored.versions.find((item) => item.version === wanted)
    return version ? HttpResponse.json({ skill: stored.summary, version }) : error('SKILL_VERSION_NOT_FOUND', 'The skill version was not found.', 404)
  }),
  http.get('/api/management/workspaces/:workspaceId/skills/:skillId/usage', ({ params }) => {
    const stored = skills.get(key(String(params.workspaceId), String(params.skillId)))
    if (!stored) return error('SKILL_NOT_FOUND', 'The skill was not found.', 404)
    const outdated = (users.get(key(String(params.workspaceId), String(params.skillId))) ?? []).filter(user => user.version !== stored.summary.version)
    return HttpResponse.json({ skillId: stored.summary.skillId, headVersion: stored.summary.version,
      agents: outdated.map(({ agentId, name, version }) => ({ agentId, name, version })),
      workflows: outdated.flatMap(user => user.workflows) })
  }),
  http.post('/api/management/workspaces/:workspaceId/skills/:skillId/update-users', ({ params }) => {
    const stored = skills.get(key(String(params.workspaceId), String(params.skillId)))
    if (!stored) return error('SKILL_NOT_FOUND', 'The skill was not found.', 404)
    const outdated = (users.get(key(String(params.workspaceId), String(params.skillId))) ?? []).filter(user => user.version !== stored.summary.version)
    for (const user of outdated) user.version = stored.summary.version
    return HttpResponse.json({ headVersion: stored.summary.version,
      agents: outdated.map(user => ({ agentId: user.agentId, configurationVersionId: `${user.agentId}-config-v${stored.summary.version}` })),
      workflows: outdated.flatMap(user => user.workflows.map(workflow => ({ workflowId: workflow.workflowId, workflowVersionId: `${workflow.workflowId}-next` }))),
      failed: [] })
  }),
  http.get('/api/management/workspaces/:workspaceId/skills/:skillId/versions', ({ params }) => {
    const stored = skills.get(key(String(params.workspaceId), String(params.skillId)))
    if (!stored) return error('SKILL_NOT_FOUND', 'The skill was not found.', 404)
    return HttpResponse.json({ items: [...stored.versions].reverse().map((version) => { const rest: Partial<SkillVersion> = { ...version }; delete rest.instructions; return rest }), pageInfo: { nextCursor: null } })
  }),
  http.patch('/api/management/workspaces/:workspaceId/skills/:skillId', ({ request, params }) => command(request, (raw) => {
    const input = SkillUpdateInputSchema.safeParse(raw)
    const stored = skills.get(key(String(params.workspaceId), String(params.skillId)))
    if (!input.success) return error('INVALID_REQUEST', 'The request does not match its shared contract.', 400)
    if (!stored) return error('SKILL_NOT_FOUND', 'The skill was not found.', 404)
    if (stored.summary.archived) return error('SKILL_ARCHIVED', 'Restore this archived skill before editing it.', 409)
    if (stored.summary.revision !== input.data.expectedRevision) return error('SKILL_REVISION_CONFLICT', 'This skill changed since you opened it.', 409, { currentRevision: stored.summary.revision })
    const current = stored.versions.at(-1)!
    if (current.name === input.data.name && (current.description ?? '') === (input.data.description ?? '') && current.instructions === input.data.instructions) {
      return { skill: stored.summary, version: current, changed: false }
    }
    const version = save(stored, input.data)
    return { skill: stored.summary, version, changed: true }
  })),
  http.put('/api/management/workspaces/:workspaceId/skills/:skillId/archive', ({ request, params }) => command(request, (raw) => {
    const input = SkillArchiveInputSchema.safeParse(raw)
    const stored = skills.get(key(String(params.workspaceId), String(params.skillId)))
    if (!input.success || !stored) return error('SKILL_NOT_FOUND', 'The skill was not found.', 404)
    if (stored.summary.revision !== input.data.expectedRevision) return error('SKILL_REVISION_CONFLICT', 'This skill changed since you opened it.', 409, { currentRevision: stored.summary.revision })
    const changed = stored.summary.archived !== input.data.archived
    if (changed) stored.summary = { ...stored.summary, archived: input.data.archived, revision: stored.summary.revision + 1, updatedAt: now() }
    return { skill: stored.summary, version: stored.versions.at(-1)!, changed }
  })),
]
