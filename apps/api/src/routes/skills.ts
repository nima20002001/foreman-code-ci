import type { FastifyInstance } from 'fastify'
import {
  SkillArchiveInputSchema, SkillCreateInputSchema, SkillGetInputSchema, SkillGetResultSchema, SkillListInputSchema,
  SkillMutationResultSchema, SkillPageSchema, SkillUpdateInputSchema, SkillVersionListInputSchema, SkillVersionPageSchema,
  SkillUsageInputSchema, SkillUsageSchema, SkillUsersUpdateInputSchema, SkillUsersUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { requirePrincipal } from '../modules/access/http.js'
import type { SkillCatalogService } from '../modules/skills/catalog.js'
import { DomainError } from '../modules/errors.js'

type Params = Record<string, string>
type Query = Record<string, string | undefined>

function body(params: Params, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_INPUT', 'The request body must be an object.', 400)
  const input = value as Record<string, unknown>
  for (const [key, id] of Object.entries(params)) {
    if (Object.hasOwn(input, key) && input[key] !== id) throw new DomainError('RESOURCE_ID_MISMATCH', `Body field '${key}' must match the URL.`, 400)
  }
  return { ...input, ...params }
}
function page(query: Query) {
  return { ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.limit ? { limit: Number(query.limit) } : {}) }
}

/** Thin HTTP client of the same Skills service the Operator MCP tools use. */
export function registerSkillRoutes(app: FastifyInstance, skills: SkillCatalogService,
  usage?: import('../modules/skills/usage.js').SkillUsageService): void {
  const base = '/api/management/workspaces/:workspaceId/skills'
  app.get<{ Querystring: Query }>('/api/management/skills', async (request) =>
    SkillPageSchema.parse(await skills.list(requirePrincipal(request), SkillListInputSchema.parse({ ...page(request.query),
      ...(request.query.workspaceId ? { workspaceId: request.query.workspaceId } : {}),
      ...(request.query.query ? { query: request.query.query } : {}),
      ...(request.query.includeArchived ? { includeArchived: request.query.includeArchived === 'true' } : {}) }))))
  app.post<{ Params: Params; Body: unknown }>(base, async (request, reply) => {
    const result = await skills.create(requirePrincipal(request), SkillCreateInputSchema.parse(body(request.params, request.body)), 'http')
    reply.code(result.replayed ? 200 : 201)
    return SkillMutationResultSchema.parse(result)
  })
  app.get<{ Params: Params; Querystring: Query }>(`${base}/:skillId`, async (request) =>
    SkillGetResultSchema.parse(await skills.get(requirePrincipal(request), SkillGetInputSchema.parse({ ...request.params,
      ...(request.query.version ? { version: request.query.version } : {}) }))))
  app.get<{ Params: Params; Querystring: Query }>(`${base}/:skillId/versions`, async (request) =>
    SkillVersionPageSchema.parse(await skills.versions(requirePrincipal(request), SkillVersionListInputSchema.parse({ ...request.params, ...page(request.query) }))))
  app.patch<{ Params: Params; Body: unknown }>(`${base}/:skillId`, async (request) =>
    SkillMutationResultSchema.parse(await skills.update(requirePrincipal(request), SkillUpdateInputSchema.parse(body(request.params, request.body)), 'http')))
  app.put<{ Params: Params; Body: unknown }>(`${base}/:skillId/archive`, async (request) =>
    SkillMutationResultSchema.parse(await skills.archive(requirePrincipal(request), SkillArchiveInputSchema.parse(body(request.params, request.body)), 'http')))
  if (!usage) return
  app.get<{ Params: Params }>(`${base}/:skillId/usage`, async (request) =>
    SkillUsageSchema.parse(await usage.usage(requirePrincipal(request), SkillUsageInputSchema.parse(request.params))))
  app.post<{ Params: Params; Body: unknown }>(`${base}/:skillId/update-users`, async (request) =>
    SkillUsersUpdateResultSchema.parse(await usage.updateUsers(requirePrincipal(request), 'http',
      SkillUsersUpdateInputSchema.parse(body(request.params, request.body)))))
}
