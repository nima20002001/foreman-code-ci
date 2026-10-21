import { MemoryBoardSearchSchema } from '@foreman-code/contracts'
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { ApprovalInboxSearchSchema, UrlSearchSelectionSchema, BrowserProfilesSettingsSearchSchema } from '@foreman-code/contracts'
import { RunsSelectorSearchSchema } from '../features/runs-selector'
import { RootShell } from './RootShell'
import { AgentSettingsSearchSchema, BugsSettingsSearchSchema, SkillSettingsSearchSchema } from '@foreman-code/contracts/management'
import { BugsSettingsRouteEntry, GeneralSettingsRouteEntry, NewSkillRouteEntry, SkillDetailRouteEntry, SkillsSettingsRouteEntry, SystemPromptSettingsRouteEntry, WorkspaceDefaultsSettingsRouteEntry } from '../routes/SettingsExperienceRoutes'

import { ProviderAccountsSettingsSearchSchema } from '../features/provider-accounts/providerAccountsNavigation'
import { ComputersSettingsRouteEntry, ComputerDetailsSettingsRouteEntry, BrowserProfilesSettingsRouteEntry } from '../routes/SettingsExperienceRoutes'

import { WorkspaceRouteEntry } from '../routes/WorkspaceRouteEntry'
import {
  AgentsRouteEntry,
  ComingSoonRouteEntry,
  GlobalComingSoonRouteEntry,
  GlobalSettingsRouteEntry,
  HarnessSettingsRouteEntry,
  AgentSettingsRouteEntry,
  WorkflowSettingsRouteEntry,
  GlobalApprovalsRouteEntry,
  WorkspaceApprovalsRouteEntry,
  WorkspaceLocationSettingsRouteEntry,
  SettingsRouteEntry,
  ProjectFilesRouteEntry,
  WorkflowsRouteEntry,
  WorkspacesRouteEntry,
  WorkspaceMemoryRouteEntry,
} from '../routes/WorkspaceSectionRoutes'

const rootRoute = createRootRoute({ component: RootShell })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/workspaces' })
  },
})

const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces',
  component: WorkspacesRouteEntry,
})

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId',
  validateSearch: RunsSelectorSearchSchema,
  component: WorkspaceRouteEntry,
})

// Linkable Board selections are children of the board, not independent screen mounts.
const nextDraftRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'workflows/$workflowId/draft',
})

const runGraphRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'workflows/$workflowId/runs/$runId/graph/$workflowVersionId/$executionSemanticsVersion',
})

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/workflows',
  component: WorkflowsRouteEntry,
  validateSearch: MemoryBoardSearchSchema,
})

const jobsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/jobs',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/workspaces/$workspaceId', params, replace: true })
  },
})
const jobDetailsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/jobs/$',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/workspaces/$workspaceId', params: { workspaceId: params.workspaceId }, replace: true })
  },
})
const computersSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/computers',
  component: ComputersSettingsRouteEntry,
})
const browserProfilesSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/settings/browser-profiles',
  validateSearch: BrowserProfilesSettingsSearchSchema, component: BrowserProfilesSettingsRouteEntry,
})
const computerDetailsSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/computers/$deviceId',
  component: ComputerDetailsSettingsRouteEntry,
})

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/agents',
  validateSearch: UrlSearchSelectionSchema,
  component: AgentsRouteEntry,
})

function comingSoonRoute(
  path:
    | '/workspaces/$workspaceId/tasks'
    | '/workspaces/$workspaceId/runs'
    | '/workspaces/$workspaceId/terminal'
    | '/workspaces/$workspaceId/files',
  section: 'tasks' | 'runs' | 'terminal' | 'files',
  label: string,
) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <ComingSoonRouteEntry section={section} label={label} />,
  })
}

const tasksRoute = comingSoonRoute('/workspaces/$workspaceId/tasks', 'tasks', 'Tasks')
const runsRoute = comingSoonRoute('/workspaces/$workspaceId/runs', 'runs', 'Runs')
const terminalRoute = comingSoonRoute('/workspaces/$workspaceId/terminal', 'terminal', 'Terminal')
const filesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/workspaces/$workspaceId/files', component: ProjectFilesRouteEntry })
const memoryRoute = createRoute({ getParentRoute: () => rootRoute, path: '/workspaces/$workspaceId/memory', component: WorkspaceMemoryRouteEntry })
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/settings',
  component: SettingsRouteEntry,
})
const workspaceLocationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/settings/location',
  component: WorkspaceLocationSettingsRouteEntry,
})
const globalTerminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terminal',
  component: () => <GlobalComingSoonRouteEntry section="terminal" label="Terminal" />,
})
const globalSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: GlobalSettingsRouteEntry,
})
const accountRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  beforeLoad: () => {
    throw redirect({ to: '/settings/general', replace: true })
  },
})
const generalSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/general',
  component: GeneralSettingsRouteEntry,
})
const bugsSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/bugs',
  validateSearch: BugsSettingsSearchSchema,
  component: BugsSettingsRouteEntry,
})
const systemPromptSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/system-prompt',
  component: SystemPromptSettingsRouteEntry,
})
const harnessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/harnesses',
  validateSearch: ProviderAccountsSettingsSearchSchema,
  component: HarnessSettingsRouteEntry,
})
const agentSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/agents',
  validateSearch: AgentSettingsSearchSchema,
  component: AgentSettingsRouteEntry,
})
const skillsSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/skills',
  validateSearch: SkillSettingsSearchSchema,
  component: SkillsSettingsRouteEntry,
})
const newSkillRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/skills/new',
  validateSearch: SkillSettingsSearchSchema.pick({ workspace: true }),
  component: NewSkillRouteEntry,
})
const skillDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/skills/$workspaceId/$skillId',
  component: SkillDetailRouteEntry,
})
const workspaceDefaultsSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/workspaces',
  component: WorkspaceDefaultsSettingsRouteEntry,
})
const workflowSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/workflows',
  component: WorkflowSettingsRouteEntry,
})
const globalApprovalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/approvals',
  validateSearch: ApprovalInboxSearchSchema,
  component: GlobalApprovalsRouteEntry,
})
const workspaceApprovalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/approvals',
  validateSearch: ApprovalInboxSearchSchema,
  component: WorkspaceApprovalsRouteEntry,
})

export const routeTree = rootRoute.addChildren([
  indexRoute,
  workspacesRoute,
  workspaceRoute.addChildren([nextDraftRoute, runGraphRoute]),
  workflowsRoute,
  jobsRedirectRoute,
  jobDetailsRedirectRoute,
  agentsRoute,
  tasksRoute,
  runsRoute,
  terminalRoute,
  filesRoute,
  memoryRoute,
  settingsRoute,
  workspaceLocationSettingsRoute,
  globalTerminalRoute,
  globalSettingsRoute,
  accountRedirectRoute,
  generalSettingsRoute,
  bugsSettingsRoute,
  systemPromptSettingsRoute,
  harnessSettingsRoute,
  computersSettingsRoute,
  browserProfilesSettingsRoute,
  computerDetailsSettingsRoute,
  agentSettingsRoute,
  skillsSettingsRoute,
  newSkillRoute,
  skillDetailRoute,
  workflowSettingsRoute,
  workspaceDefaultsSettingsRoute,
  globalApprovalsRoute,
  workspaceApprovalsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
