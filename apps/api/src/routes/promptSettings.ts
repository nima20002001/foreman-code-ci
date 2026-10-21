import type { FastifyInstance } from 'fastify'
import {
  ManagedPromptSettingSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { requirePrincipal } from '../modules/access/http.js'
import type { FoundationSettingsManagementService } from '../modules/settings/management.js'

export function registerPromptSettingsRoutes(app: FastifyInstance, settings: FoundationSettingsManagementService): void {
  app.get('/api/management/settings/system-prompt', async request =>
    ManagedPromptSettingSchema.parse(await settings.getSystemPrompt(requirePrincipal(request))))
  app.put<{ Body: unknown }>('/api/management/settings/system-prompt', async request =>
    PromptSettingUpdateResultSchema.parse(await settings.updateSystemPrompt(
      requirePrincipal(request), 'http', PromptSettingUpdateInputSchema.parse(request.body),
    )))
  app.get('/api/management/settings/operator-initial-prompt', async request =>
    ManagedPromptSettingSchema.parse(await settings.getOperatorInitialPrompt(requirePrincipal(request))))
  app.put<{ Body: unknown }>('/api/management/settings/operator-initial-prompt', async request =>
    PromptSettingUpdateResultSchema.parse(await settings.updateOperatorInitialPrompt(
      requirePrincipal(request), 'http', PromptSettingUpdateInputSchema.parse(request.body),
    )))
}
