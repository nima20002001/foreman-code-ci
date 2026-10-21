import { requireHarnessOptionsAccountAccess } from '../modules/harnesses/harnessOptionsAccess.js'
import { registerClaudePluginRoutes } from './claudePlugins.js'
import type { FastifyInstance } from 'fastify'
import { pluginHttpRead } from './pluginReadCancellation.js'
import {
  ExecutionReadinessInputSchema, ExecutionReadinessSchema,
  HarnessOptionsInputSchema, HarnessOptionsRefreshInputSchema, HarnessOptionsResultSchema, HarnessMcpListInputSchema, HarnessMcpListResultSchema,
  HarnessMcpManagedInputSchema, HarnessMcpPlanInputSchema, HarnessMcpPlanResultSchema, HarnessMcpPlansResultSchema, HarnessMcpPlanSchema,
  HarnessMcpPlanGetInputSchema, HarnessMcpDecisionInputSchema, HarnessMcpReconcileInputSchema,
  HarnessDirectoryBrowseInputSchema, HarnessDirectoryBrowseResultSchema,
  WorkspaceFolderUndoInputSchema, WorkspaceFolderUndoResultSchema,
  WorkspaceFolderCreateInputSchema, WorkspaceFolderCreateResultSchema, WorkspaceFolderRenameInputSchema, WorkspaceFolderRenameResultSchema,
  CodexPluginListInputSchema, CodexPluginListResultSchema, CodexPluginGetInputSchema, CodexPluginDetailResultSchema,
  CodexPluginChangeInputSchema, CodexPluginChangeResultSchema, CodexPluginOperationsResultSchema, CodexPluginReconcileInputSchema,
} from '@foreman-code/contracts/management'
import { requireLocalHuman, requirePrincipal } from '../modules/access/http.js'
import { requireAuthorization } from '../modules/access/policy.js'
import { DomainError } from '../modules/errors.js'
import type { OperatorServices } from '../mcp/operator/types.js'
import { WorkspaceFolderDeleteInputSchema, WorkspaceFolderDeleteResultSchema } from '@foreman-code/contracts/management'
import { ClaudeSetupOptionsSchema } from '@foreman-code/contracts/claude'

export function registerHarnessSettingsRoutes(app: FastifyInstance, services: OperatorServices): void {
  registerClaudePluginRoutes(app, services)
  app.get('/api/management/harnesses/claude/setup-options', async (request) =>
    ClaudeSetupOptionsSchema.parse(services.harnesses.claudeSetupOptions(requirePrincipal(request))))
  app.get('/api/management/harnesses/:harness/execution-readiness', async (request) => {
    const principal = requirePrincipal(request)
    requireAuthorization(principal, 'harnesses:read')
    const { harness, scope, configurationVersionId } = ExecutionReadinessInputSchema.parse({ ...request.params as object, ...request.query as object })
    if (!services.executionReadiness) throw new DomainError('READINESS_UNAVAILABLE', 'Execution readiness is unavailable.', 503)
    return ExecutionReadinessSchema.parse(await services.executionReadiness.get(principal, harness, scope, configurationVersionId))
  })
  app.get('/api/management/harnesses/:harness/options', async (request) => {
    requireAuthorization(requirePrincipal(request), 'harnesses:read')
    const query = request.query as { hostRef?: string; accountBinding?: string }
    const { harness, hostRef, accountBinding } = HarnessOptionsInputSchema.parse({ ...request.params as object,
      ...(query.hostRef ? { hostRef: JSON.parse(query.hostRef) } : {}),
      ...(query.accountBinding ? { accountBinding: JSON.parse(query.accountBinding) } : {}) })
    if (!services.extensions?.native) throw new DomainError('NATIVE_OPTIONS_UNAVAILABLE', 'Native model discovery is unavailable.', 503)
    await requireHarnessOptionsAccountAccess(requirePrincipal(request), accountBinding, services.providerAccounts)
    return HarnessOptionsResultSchema.parse(await services.extensions.native.options(harness, accountBinding, hostRef))
  })
  app.post('/api/management/harnesses/:harness/refresh', async (request) => {
    const principal = requirePrincipal(request)
    requireAuthorization(principal, 'harnesses:read')
    const { harness } = HarnessOptionsInputSchema.parse(request.params)
    const { refresh, hostRef, accountBinding } = HarnessOptionsRefreshInputSchema.parse({ harness, ...(request.body as object ?? {}) })
    if (refresh === 'upstream') requireAuthorization(principal, 'harnesses:update')
    await requireHarnessOptionsAccountAccess(principal, accountBinding, services.providerAccounts)
    services.harnesses.invalidateChecks()
    if (!services.extensions?.native) throw new DomainError('NATIVE_OPTIONS_UNAVAILABLE', 'Native discovery is unavailable.', 503)
    return HarnessOptionsResultSchema.parse(await services.extensions.native.refreshOptions(harness, refresh, accountBinding, hostRef))
  })
  const settings = () => {
    if (!services.harnessSettings) throw new DomainError('HARNESS_SETTINGS_UNAVAILABLE', 'Native connection management is unavailable.', 503)
    return services.harnessSettings
  }
  app.get('/api/management/harnesses/codex/plugins', async (request, reply) => {
    const plugins = settings().plugins
    if (!plugins) throw new DomainError('CODEX_PLUGINS_UNAVAILABLE', 'Codex plugin management is unavailable.', 503)
    return pluginHttpRead(request, reply, async (signal) => CodexPluginListResultSchema.parse(
      await plugins.list(requirePrincipal(request), CodexPluginListInputSchema.parse(request.query), signal)))
  })
  app.get('/api/management/harnesses/codex/plugins/:pluginId', async (request, reply) => {
    const plugins = settings().plugins
    if (!plugins) throw new DomainError('CODEX_PLUGINS_UNAVAILABLE', 'Codex plugin management is unavailable.', 503)
    const input = CodexPluginGetInputSchema.parse({ ...request.params as object, ...request.query as object })
    return pluginHttpRead(request, reply, async (signal) => CodexPluginDetailResultSchema.parse(
      await plugins.get(requirePrincipal(request), input.pluginId, { signal, refresh: input.refresh })))
  })
  app.get('/api/management/harnesses/codex/plugins/operations', async (request) => {
    const plugins = settings().plugins
    if (!plugins) throw new DomainError('CODEX_PLUGINS_UNAVAILABLE', 'Codex plugin management is unavailable.', 503)
    return CodexPluginOperationsResultSchema.parse(await plugins.operations(requirePrincipal(request)))
  })
  app.post('/api/management/harnesses/codex/plugins/reconcile', async (request) => {
    const plugins = settings().plugins
    if (!plugins) throw new DomainError('CODEX_PLUGINS_UNAVAILABLE', 'Codex plugin management is unavailable.', 503)
    return CodexPluginChangeResultSchema.parse(await plugins.reconcile(requirePrincipal(request), CodexPluginReconcileInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/codex/plugins/change', async (request) => {
    const plugins = settings().plugins
    if (!plugins) throw new DomainError('CODEX_PLUGINS_UNAVAILABLE', 'Codex plugin management is unavailable.', 503)
    return CodexPluginChangeResultSchema.parse(await plugins.change(requirePrincipal(request), CodexPluginChangeInputSchema.parse(request.body)))
  })
  app.get('/api/management/harnesses/:harness/mcp', async (request) => {
    const query = request.query as { hostRef?: string }
    const { harness, hostRef } = HarnessMcpListInputSchema.parse({ ...request.params as object,
      ...(query.hostRef ? { hostRef: JSON.parse(query.hostRef) } : {}) })
    return HarnessMcpListResultSchema.parse(await settings().mcp.list(requirePrincipal(request), harness, hostRef))
  })
  app.get('/api/management/harnesses/:harness/mcp/plans', async (request) => {
    const { harness } = HarnessMcpListInputSchema.parse(request.params)
    return HarnessMcpPlansResultSchema.parse(await settings().mcp.plans(requirePrincipal(request), harness))
  })
  app.post('/api/management/harnesses/mcp/plans', async (request) => HarnessMcpPlanResultSchema.parse(
    await settings().mcp.plan(requirePrincipal(request), 'http', HarnessMcpPlanInputSchema.parse(request.body))))
  app.post('/api/management/harnesses/mcp/managed', async (request) => {
    return HarnessMcpPlanSchema.parse(await settings().mcp.applyManaged(requirePrincipal(request), HarnessMcpManagedInputSchema.parse(request.body)))
  })
  app.get('/api/management/harnesses/mcp/plans/:planId', async (request) => HarnessMcpPlanSchema.parse(
    await settings().mcp.get(requirePrincipal(request), HarnessMcpPlanGetInputSchema.parse(request.params).planId)))
  app.post('/api/management/harnesses/mcp/reconcile', async (request) => {
    return HarnessMcpPlanResultSchema.parse(await settings().mcp.reconcile(
      requirePrincipal(request), HarnessMcpReconcileInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/mcp/decision', async (request) => {
    const input = HarnessMcpDecisionInputSchema.parse(request.body)
    return HarnessMcpPlanSchema.parse(await settings().mcp.decide(requirePrincipal(request), input.planId, input.approve))
  })
  app.post('/api/management/harnesses/directories/delete', async (request) => {
    requireLocalHuman(request)
    return WorkspaceFolderDeleteResultSchema.parse(await settings().directories.deleteFolders(
      requirePrincipal(request), 'http', WorkspaceFolderDeleteInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/directories/undo', async (request) => {
    return WorkspaceFolderUndoResultSchema.parse(await settings().directories.undoCreated(
      requirePrincipal(request), 'http', WorkspaceFolderUndoInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/directories/rename', async (request) => {
    return WorkspaceFolderRenameResultSchema.parse(await settings().directories.renameCreated(
      requirePrincipal(request), 'http', WorkspaceFolderRenameInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/directories', async (request) => {
    return WorkspaceFolderCreateResultSchema.parse(await settings().directories.create(
      requirePrincipal(request), 'http', WorkspaceFolderCreateInputSchema.parse(request.body)))
  })
  app.get('/api/management/harnesses/directories', async (request) => {
    return HarnessDirectoryBrowseResultSchema.parse(await settings().directories.browse(requirePrincipal(request), HarnessDirectoryBrowseInputSchema.parse(request.query)))
  })
}
