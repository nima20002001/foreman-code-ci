import type { FastifyInstance } from 'fastify'
import {
  ClaudePluginListInputSchema, ClaudePluginListResultSchema,
  ClaudePluginChangeInputSchema, ClaudePluginChangeResultSchema,
  ClaudePluginMarketplaceAddInputSchema, ClaudePluginMarketplaceAddResultSchema,
} from '@foreman-code/contracts/management'
import type { OperatorServices } from '../mcp/operator/types.js'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import { pluginHttpRead } from './pluginReadCancellation.js'

export function registerClaudePluginRoutes(app: FastifyInstance, services: OperatorServices): void {
  const plugins = () => {
    const service = services.harnessSettings?.claudePlugins
    if (!service) throw new DomainError('CLAUDE_PLUGINS_UNAVAILABLE', 'Claude plugin management is unavailable.', 503)
    return service
  }
  app.get('/api/management/harnesses/claude/plugins', (request, reply) =>
    pluginHttpRead(request, reply, async signal => ClaudePluginListResultSchema.parse(
      await plugins().list(requirePrincipal(request), ClaudePluginListInputSchema.parse(request.query), signal))))
  app.post('/api/management/harnesses/claude/plugins/change', async request =>
    ClaudePluginChangeResultSchema.parse(await plugins().change(
      requirePrincipal(request), ClaudePluginChangeInputSchema.parse(request.body))))
  app.post('/api/management/harnesses/claude/plugins/marketplaces', async request =>
    ClaudePluginMarketplaceAddResultSchema.parse(await plugins().addMarketplace(
      requirePrincipal(request), ClaudePluginMarketplaceAddInputSchema.parse(request.body))))
}
