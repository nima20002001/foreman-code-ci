import { z } from 'zod'
import {
  ProviderAccountsSnapshotSchema, ProviderAccountUpdateResultSchema, ProviderAccountSchema,
  ProviderAccountCreateInputSchema, ProviderAccountRenameInputSchema, ProviderAccountDefaultInputSchema,
  ProviderAccountCommandInputSchema, ProviderAccountApiKeyInputSchema, ProviderAccountPageSchema,
  ProviderAccountListInputSchema, ProviderAccountModelsSchema,
  ProviderAccountAuthenticationPrepareInputSchema, ProviderAccountAuthenticationReadInputSchema,
  ProviderAccountAuthenticationCancelInputSchema, ProviderAccountAuthenticationResultSchema,
  ProviderAccountAuthenticationOperationSchema,
  ProviderAccountGetInputSchema, ProviderAccountRegisterInputSchema, ProviderAccountDiscoveryInputSchema,
  ProviderAccountTargetsSchema, ProviderAccountProfilesSchema, ProviderAccountEligibilitySchema,
  ProviderAccountAuthenticationListInputSchema, ProviderAccountAuthenticationPageSchema, ProviderAccountHumanHandoffSchema,
  type ProviderAccountCreateInput, type ProviderAccountRenameInput,
  type ProviderAccountCommandInput,
} from '@foreman-code/contracts/provider-accounts'
import { apiClient, type RequestOptions } from '../../shared/api/client'

const root = '/api/provider-accounts'
export type ProviderAccountAction = 'default' | 'login' | 'logout' | 'refresh' | 'remove'
export type ProviderAccountPrepareInput = z.input<typeof ProviderAccountAuthenticationPrepareInputSchema>
export type ProviderAccountCancelInput = z.input<typeof ProviderAccountAuthenticationCancelInputSchema>
export type ProviderAccountDefaultInput = z.input<typeof ProviderAccountDefaultInputSchema>
export type ProviderAccountRegisterInput = z.input<typeof ProviderAccountRegisterInputSchema>

function queryString(input: { target?: z.infer<typeof ProviderAccountGetInputSchema>['target'];
  provider?: string; cursor?: string; limit?: number; includeRemoved?: boolean }) {
  const search = new URLSearchParams()
  if (input.target) search.set('target', JSON.stringify(input.target))
  if (input.provider) search.set('provider', input.provider)
  if (input.cursor) search.set('cursor', input.cursor)
  if (input.limit !== undefined) search.set('limit', String(input.limit))
  if (input.includeRemoved !== undefined) search.set('includeRemoved', String(input.includeRemoved))
  return search.toString()
}

export const providerAccountsClient = {
  list(options?: RequestOptions) {
    return apiClient.request(root, ProviderAccountsSnapshotSchema, options)
  },
  page(input: z.input<typeof ProviderAccountListInputSchema>, options?: RequestOptions) {
    const parsed = ProviderAccountListInputSchema.parse(input)
    const search = queryString(parsed)
    return apiClient.request(`${root}/page?${search}`, ProviderAccountPageSchema, options)
  },
  targets(options?: RequestOptions) {
    return apiClient.request(`${root}/targets`, ProviderAccountTargetsSchema, options)
  },
  profiles(input: z.input<typeof ProviderAccountDiscoveryInputSchema>, options?: RequestOptions) {
    const search = queryString(ProviderAccountDiscoveryInputSchema.parse(input))
    return apiClient.request(`${root}/profiles?${search}`, ProviderAccountProfilesSchema, options)
  },
  eligibility(input: z.input<typeof ProviderAccountGetInputSchema>, options?: RequestOptions) {
    const parsed = ProviderAccountGetInputSchema.parse(input)
    return apiClient.request(`${root}/${encodeURIComponent(parsed.accountId)}/eligibility?${queryString(parsed)}`,
      ProviderAccountEligibilitySchema, options)
  },
  authenticationList(input: z.input<typeof ProviderAccountAuthenticationListInputSchema>, options?: RequestOptions) {
    const parsed = ProviderAccountAuthenticationListInputSchema.parse(input)
    return apiClient.request(`${root}/${encodeURIComponent(parsed.accountId)}/authentication?${queryString(parsed)}`,
      ProviderAccountAuthenticationPageSchema, options)
  },
  get(input: z.input<typeof ProviderAccountGetInputSchema>, options?: RequestOptions) {
    const parsed = ProviderAccountGetInputSchema.parse(input)
    return apiClient.request(`${root}/${encodeURIComponent(parsed.accountId)}?${queryString(parsed)}`, ProviderAccountSchema, options)
  },
  models(input: z.input<typeof ProviderAccountGetInputSchema>, options?: RequestOptions) {
    const parsed = ProviderAccountGetInputSchema.parse(input)
    return apiClient.request(`${root}/${encodeURIComponent(parsed.accountId)}/models?${queryString(parsed)}`,
      ProviderAccountModelsSchema, options)
  },
  handoff(input: z.input<typeof ProviderAccountAuthenticationReadInputSchema>, options?: RequestOptions) {
    return apiClient.request(`${root}/authentication/handoff`, ProviderAccountHumanHandoffSchema, {
      ...options, method: 'POST', body: ProviderAccountAuthenticationReadInputSchema.parse(input),
      cache: 'no-store', referrerPolicy: 'no-referrer',
    })
  },
  prepare(accountId: string, input: ProviderAccountPrepareInput) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/authentication`,
      ProviderAccountAuthenticationResultSchema, {
        method: 'POST', body: ProviderAccountAuthenticationPrepareInputSchema.parse(input),
      })
  },
  authentication(input: z.input<typeof ProviderAccountAuthenticationReadInputSchema>, options?: RequestOptions) {
    return apiClient.request(`${root}/authentication/status`, ProviderAccountAuthenticationOperationSchema, {
      ...options, method: 'POST', body: ProviderAccountAuthenticationReadInputSchema.parse(input),
    })
  },
  cancel(input: ProviderAccountCancelInput) {
    return apiClient.request(`${root}/authentication/cancel`, ProviderAccountAuthenticationResultSchema, {
      method: 'POST', body: ProviderAccountAuthenticationCancelInputSchema.parse(input),
    })
  },
  create(input: ProviderAccountCreateInput) {
    return apiClient.request(root, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: ProviderAccountCreateInputSchema.parse(input),
    })
  },
  register(input: ProviderAccountRegisterInput) {
    return apiClient.request(`${root}/register`, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: ProviderAccountRegisterInputSchema.parse(input),
    })
  },
  rename(accountId: string, input: ProviderAccountRenameInput) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}`, ProviderAccountUpdateResultSchema, {
      method: 'PATCH', body: ProviderAccountRenameInputSchema.parse(input),
    })
  },
  action(accountId: string, action: ProviderAccountAction, input: ProviderAccountCommandInput | ProviderAccountDefaultInput) {
    const schema = action === 'default' ? ProviderAccountDefaultInputSchema : ProviderAccountCommandInputSchema
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/${action}`, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: schema.parse(input),
    })
  },
  apiKey(accountId: string, input: z.input<typeof ProviderAccountApiKeyInputSchema>) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/api-key`, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: ProviderAccountApiKeyInputSchema.parse(input),
    })
  },
}
