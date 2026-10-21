import { z } from 'zod'
import {
  ProviderAccountCreateInputSchema, ProviderAccountsSnapshotSchema,
  ProviderAccountToolCommandSchema, ProviderAccountToolRenameSchema, ProviderAccountUpdateResultSchema,
  ProviderAccountListInputSchema, ProviderAccountPageSchema, ProviderAccountGetInputSchema, ProviderAccountSchema,
  ProviderAccountRegisterInputSchema, ProviderAccountAuthenticationPrepareInputSchema,
  ProviderAccountAuthenticationReadInputSchema, ProviderAccountAuthenticationCancelInputSchema,
  ProviderAccountAuthenticationOperationSchema, ProviderAccountAuthenticationResultSchema,
  ProviderAccountTargetsSchema, ProviderAccountDiscoveryInputSchema, ProviderAccountProfilesSchema,
  ProviderAccountEligibilitySchema, ProviderAccountAuthenticationListInputSchema, ProviderAccountAuthenticationPageSchema,
  ProviderAccountModelsInputSchema, ProviderAccountModelsSchema, ProviderAccountDefaultInputSchema,
} from '@foreman-code/contracts/provider-accounts'
import { hasAction } from '../../../modules/access/policy.js'
import { defineOperatorTool } from '../definition.js'
import type { OperatorRequestContext } from '../types.js'

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const writeAnnotations = { ...readAnnotations, readOnlyHint: false }
/** Manage credentials include these actions; resource scope is checked by the service. */
const canRead = (context: OperatorRequestContext) => hasAction(context.principal, 'provider_accounts:read')
const canManage = (context: OperatorRequestContext) => canRead(context) && hasAction(context.principal, 'provider_accounts:manage')
const readRequires = [['provider_accounts:read', 'global']] as const
const manageRequires = [['provider_accounts:manage', 'global'], ['provider_accounts:read', 'global']] as const

export const providerAccountTools = [
  defineOperatorTool({
    name: 'provider_accounts_page',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Read a target-identified cursor page with fresh ordered observations and independently revisioned defaults. Included in the manage preset; requires provider_accounts:read on the target.',
    inputSchema: ProviderAccountListInputSchema, outputSchema: ProviderAccountPageSchema, annotations: readAnnotations,
    run: (context, input) => context.services.providerAccounts!.page(context.principal, input),
  }),
  defineOperatorTool({
    name: 'provider_account_get',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Read the persisted binding/removal state and a fresh selected-slot observation without changing metadata revisions. Requires provider_accounts:read on the target/account.',
    inputSchema: ProviderAccountGetInputSchema, outputSchema: ProviderAccountSchema, annotations: readAnnotations,
    run: (context, input) => context.services.providerAccounts!.get(context.principal, input),
  }),
  defineOperatorTool({
    name: 'provider_account_targets',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Read canonical Main/Worker targets, current generations, qualified actions and caller eligibility. Human handoff is HTTP-only.' + ' Requires target-specific provider_accounts:read.',
    inputSchema: z.object({}).strict(), outputSchema: ProviderAccountTargetsSchema, annotations: readAnnotations,
    run: (context) => context.services.providerAccounts!.targets(context.principal),
  }),
  defineOperatorTool({
    name: 'provider_account_profiles',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Read qualified existing profile choices by opaque reference. No arbitrary paths or credentials.' + ' Requires target-specific provider_accounts:read.',
    inputSchema: ProviderAccountDiscoveryInputSchema, outputSchema: ProviderAccountProfilesSchema, annotations: readAnnotations,
    run: (context, input) => context.services.providerAccounts!.profiles(context.principal, input),
  }),
  defineOperatorTool({
    name: 'provider_account_eligibility',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Read live manage and reauthentication limits for a slot, including saved uses and pending operations.' + ' Requires target-specific provider_accounts:read.',
    inputSchema: ProviderAccountGetInputSchema, outputSchema: ProviderAccountEligibilitySchema, annotations: readAnnotations,
    run: (context, input) => context.services.providerAccounts!.eligibility(context.principal, input),
  }),
  defineOperatorTool({
    name: 'provider_account_auth_list',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Discover persisted original authentication operations for one account after reconnect. Does not start or retry login.' + ' Requires target-specific provider_accounts:read.',
    inputSchema: ProviderAccountAuthenticationListInputSchema, outputSchema: ProviderAccountAuthenticationPageSchema, annotations: readAnnotations,
    run: (context, input) => context.services.providerAccounts!.authenticationList(context.principal, input),
  }),
  defineOperatorTool({
    name: 'provider_account_register',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Register an explicitly selected qualified native profile by opaque reference. No paths or credentials. Requires provider_accounts:read/manage.',
    inputSchema: ProviderAccountRegisterInputSchema, outputSchema: ProviderAccountUpdateResultSchema, annotations: writeAnnotations,
    run: (context, input) => context.services.providerAccounts!.register(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'provider_account_remove',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Remove an account from selection and clear its scoped default. Retains saved bindings and native history. Requires provider_accounts:read/manage.',
    inputSchema: ProviderAccountToolCommandSchema, outputSchema: ProviderAccountUpdateResultSchema, annotations: writeAnnotations,
    run: (context, { accountId, ...input }) => context.services.providerAccounts!.remove(context.principal, 'mcp', accountId, input),
  }),
  defineOperatorTool({
    name: 'provider_account_auth_prepare',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Reserve an authentication intent valid for one hour before native dispatch. A human completes provider authorization. Reuse the original command and expiry after an unknown response. Requires provider_accounts:read/manage.',
    inputSchema: ProviderAccountAuthenticationPrepareInputSchema.extend({ accountId: ProviderAccountGetInputSchema.shape.accountId }),
    outputSchema: ProviderAccountAuthenticationResultSchema, annotations: writeAnnotations,
    run: (context, { accountId, ...input }) => context.services.providerAccounts!.prepareAuthentication(context.principal, 'mcp', accountId, input),
  }),
  defineOperatorTool({
    name: 'provider_account_auth_status',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Reconcile the original authentication operation without starting another login. Returns sanitized lifecycle/closure only. Requires provider_accounts:read.',
    inputSchema: ProviderAccountAuthenticationReadInputSchema, outputSchema: ProviderAccountAuthenticationOperationSchema,
    annotations: readAnnotations,
    run: (context, input) => context.services.providerAccounts!.authenticationStatus(context.principal, input, 'mcp'),
  }),
  defineOperatorTool({
    name: 'provider_account_auth_cancel',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Request cancellation of the original operation. Canceled means positive native closure; otherwise outcome remains unknown. expectedRevision is the operation revision. Requires provider_accounts:read/manage.',
    inputSchema: ProviderAccountAuthenticationCancelInputSchema, outputSchema: ProviderAccountAuthenticationResultSchema,
    annotations: writeAnnotations,
    run: (context, input) => context.services.providerAccounts!.cancelAuthentication(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'provider_account_models',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Observe full native model metadata for this account/profile/installation: reasoning, variants, service tiers and catalog provenance. Discovery does not qualify execution. No model prompt or fallback. Requires provider_accounts:read.',
    inputSchema: ProviderAccountModelsInputSchema, outputSchema: ProviderAccountModelsSchema, annotations: readAnnotations,
    run: (context, input) => context.services.providerAccounts!.models(context.principal, input),
  }),
  defineOperatorTool({
    name: 'provider_accounts_list',
    requires: readRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canRead,
    description: 'Read this computer’s named Codex/ChatGPT and Claude accounts, provider defaults, sign-in '
      + 'status and snapshot revision. Credentials and local paths are never returned. Requires target-specific provider_accounts:read. '
      + 'API-key provisioning is local-human-only through Settings; MCP never receives API keys.',
    inputSchema: z.object({}).strict(), outputSchema: ProviderAccountsSnapshotSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.providerAccounts!.list(context.principal),
  }),
  defineOperatorTool({
    name: 'provider_account_create',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Create a named slot on the selected Main or qualified Worker; credentials remain with that native owner. Codex uses subscription '
      + 'sign-in; Claude supports subscription or api-key. The first account becomes its provider’s default. '
      + 'Use the snapshot expectedRevision and retry the same commandId/input after an uncertain response. '
      + 'Requires target-specific provider_accounts:read and provider_accounts:manage. API keys are provisioned only by a local human in Settings.',
    inputSchema: ProviderAccountCreateInputSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.providerAccounts!.create(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'provider_account_rename',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Rename a local provider account. expectedRevision is the accounts snapshot revision. '
      + 'Requires target-specific provider_accounts:read and provider_accounts:manage; retry identical commandId and input.',
    inputSchema: ProviderAccountToolRenameSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { accountId, ...input }) => context.services.providerAccounts!.rename(context.principal, 'mcp', accountId, input),
  }),
  defineOperatorTool({
    name: 'provider_account_default_set',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Choose the default account for new work without a saved account/profile.' + ' Requires target-specific provider_accounts:read and provider_accounts:manage. expectedRevision is the '
      + 'accounts snapshot revision; retry the same commandId and input. Credentials stay on the owning computer.',
    inputSchema: ProviderAccountDefaultInputSchema.extend({ accountId: ProviderAccountGetInputSchema.shape.accountId }), outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true,
      openWorldHint: false },
    run: (context, { accountId, ...input }) => context.services.providerAccounts!.setDefault(context.principal, 'mcp', accountId, input),
  }),
  defineOperatorTool({
    name: 'provider_account_login',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Prepare the original provider sign-in operation, valid for one hour, on the owning computer. A human completes browser authorization there. Rediscover the same operation with provider_account_auth_list after an unknown response.' + ' Requires target-specific provider_accounts:read and provider_accounts:manage. expectedRevision is the '
      + 'accounts snapshot revision; retry the same commandId and input. Credentials stay on the owning computer.',
    inputSchema: ProviderAccountToolCommandSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true,
      openWorldHint: true },
    run: (context, { accountId, ...input }) => context.services.providerAccounts!.login(context.principal, 'mcp', accountId, input),
  }),
  defineOperatorTool({
    name: 'provider_account_logout',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Prepare sign-out for this managed account. Saved uses and unproved principal ownership prevent credential replacement; native history is retained.' + ' Requires target-specific provider_accounts:read and provider_accounts:manage. expectedRevision is the '
      + 'accounts snapshot revision; retry the same commandId and input. Credentials stay on the owning computer.',
    inputSchema: ProviderAccountToolCommandSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true,
      openWorldHint: false },
    run: (context, { accountId, ...input }) => context.services.providerAccounts!.logout(context.principal, 'mcp', accountId, input),
  }),
  defineOperatorTool({
    name: 'provider_account_refresh',
    requires: manageRequires,
    enabled: s => !!s.providerAccounts,
    discoverable: canManage,
    description: 'Refresh and persist this account’s status through the provider’s own local status command.' + ' Requires target-specific provider_accounts:read and provider_accounts:manage. expectedRevision is the '
      + 'accounts snapshot revision; retry the same commandId and input. Credentials stay on the owning computer.',
    inputSchema: ProviderAccountToolCommandSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true,
      openWorldHint: false },
    run: (context, { accountId, ...input }) => context.services.providerAccounts!.refresh(context.principal, 'mcp', accountId, input),
  }),
]
