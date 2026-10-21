import type { AgentReferenceService } from '../../modules/files/references/agentService.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import type { PostgresAccessService } from '../../modules/access/postgres.js'
import type { AppInteractionService } from '../../modules/interactions/app.js'
import type { BugReportService } from '../../modules/bug-reports/service.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'

export interface AppMcpServices {
  access: PostgresAccessService
  interactions: AppInteractionService
  references?: AgentReferenceService
  bugReports?: BugReportService
  commands?: PostgresCommandCoordinator
}

export interface AppRequestContext {
  principal: ManagementPrincipal
  interactions: AppInteractionService
  bugReports?: BugReportService
  signal?: AbortSignal
}
