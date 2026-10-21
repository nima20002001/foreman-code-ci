import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import {
  SkillArchiveInputSchema, SkillCreateInputSchema, SkillGetResultSchema, SkillMutationResultSchema, SkillPageSchema,
  SkillUpdateInputSchema, SkillVersionPageSchema, SkillUsageSchema, SkillUsersUpdateResultSchema,
  type SkillArchiveInput, type SkillCreateInput, type SkillMutationResult, type SkillUpdateInput, type SkillSummary,
} from '@foreman-code/contracts/management'
import { apiClient } from '../../shared/api/client'
import { collectManagementPages, managementPageUrl } from '../../shared/api/managementPaging'

export interface SkillFilter { workspaceId?: string | undefined; query?: string | undefined; includeArchived?: boolean | undefined }

const part = encodeURIComponent
export const skillKeys = {
  all: ['workbench', 'management', 'skills'] as const,
  lists: () => [...skillKeys.all, 'list'] as const,
  list: (filter: SkillFilter) => [...skillKeys.lists(), filter.workspaceId ?? 'all', filter.query ?? '', Boolean(filter.includeArchived)] as const,
  catalog: (workspaceId: string) => [...skillKeys.lists(), 'catalog', workspaceId] as const,
  detail: (workspaceId: string, skillId: string) => [...skillKeys.all, 'detail', workspaceId, skillId] as const,
  version: (workspaceId: string, skillId: string, version: string) => [...skillKeys.detail(workspaceId, skillId), 'version', version] as const,
  versions: (workspaceId: string, skillId: string) => [...skillKeys.detail(workspaceId, skillId), 'versions'] as const,
  usage: (workspaceId: string, skillId: string) => [...skillKeys.detail(workspaceId, skillId), 'usage'] as const,
}
function listPath(filter: SkillFilter, cursor?: string, limit = 50) {
  const query = new URLSearchParams()
  if (filter.workspaceId) query.set('workspaceId', filter.workspaceId)
  if (filter.query) query.set('query', filter.query)
  if (filter.includeArchived) query.set('includeArchived', 'true')
  return managementPageUrl(`/api/management/skills${query.size ? `?${query}` : ''}`, cursor, limit)
}
const skillPath = (workspaceId: string, skillId?: string) =>
  `/api/management/workspaces/${part(workspaceId)}/skills${skillId ? `/${part(skillId)}` : ''}`

/** One row per logical skill, paged. Earlier results stay visible while a new filter loads. */
export function useSkillPages(filter: SkillFilter) {
  type Page = { items: SkillSummary[]; pageInfo: { nextCursor: string | null } }
  return useInfiniteQuery<Page, Error, InfiniteData<Page, string | undefined>, ReturnType<typeof skillKeys.list>, string | undefined>({
    queryKey: skillKeys.list(filter), initialPageParam: undefined as string | undefined,
    // Keep results visible while refining a search, never across a workspace change.
    placeholderData: (previous, query) => query?.queryKey[3] === (filter.workspaceId ?? 'all') ? keepPreviousData(previous) : undefined,
    queryFn: ({ pageParam, signal }) => apiClient.request(listPath(filter, pageParam), SkillPageSchema, { signal }),
    getNextPageParam: (page) => page.pageInfo.nextCursor ?? undefined,
  })
}
/** Every skill in one workspace, or in every readable workspace when omitted. Archived skills are
 * included only so existing pins keep their names; callers must not offer them for new assignment. */
export function useSkillCatalog(workspaceId?: string, enabled = true) {
  return useQuery({ enabled, queryKey: skillKeys.catalog(workspaceId ?? 'all'),
    queryFn: ({ signal }) => collectManagementPages((cursor) => apiClient.request(listPath({ workspaceId, includeArchived: true }, cursor, 100), SkillPageSchema, { signal }), signal) })
}
export function useSkillQuery(workspaceId: string, skillId: string, version?: string) {
  return useQuery({ enabled: Boolean(workspaceId && skillId),
    queryKey: version ? skillKeys.version(workspaceId, skillId, version) : skillKeys.detail(workspaceId, skillId),
    queryFn: ({ signal }) => apiClient.request(`${skillPath(workspaceId, skillId)}${version ? `?version=${part(version)}` : ''}`, SkillGetResultSchema, { signal }) })
}
export function useSkillVersionsQuery(workspaceId: string, skillId: string, enabled = true) {
  return useQuery({ enabled: enabled && Boolean(workspaceId && skillId), queryKey: skillKeys.versions(workspaceId, skillId),
    queryFn: ({ signal }) => collectManagementPages((cursor) => apiClient.request(managementPageUrl(`${skillPath(workspaceId, skillId)}/versions`, cursor),
      SkillVersionPageSchema, { signal }), signal) })
}

function useSkillMutation<T>(send: (input: T) => Promise<SkillMutationResult>) {
  const client = useQueryClient()
  return useMutation({ retry: false, mutationFn: send, onSuccess: (result) => {
    const { skill, version } = result.value
    // The server response is the only source of saved truth.
    // Every mutation returns the head and its version; exact-version and history reads refresh.
    client.setQueryData(skillKeys.detail(skill.workspaceId, skill.skillId), { skill, version })
    void client.invalidateQueries({ queryKey: skillKeys.versions(skill.workspaceId, skill.skillId) }).catch(() => undefined)
    void client.invalidateQueries({ queryKey: skillKeys.usage(skill.workspaceId, skill.skillId) }).catch(() => undefined)
    void client.invalidateQueries({ queryKey: skillKeys.lists() }).catch(() => undefined)
  } })
}
export function useCreateSkillMutation() {
  return useSkillMutation((input: SkillCreateInput) => {
    const body = SkillCreateInputSchema.parse(input)
    return apiClient.request(skillPath(body.workspaceId), SkillMutationResultSchema, { method: 'POST', body })
  })
}
export function useUpdateSkillMutation() {
  return useSkillMutation((input: SkillUpdateInput) => {
    const body = SkillUpdateInputSchema.parse(input)
    return apiClient.request(skillPath(body.workspaceId, body.skillId), SkillMutationResultSchema, { method: 'PATCH', body })
  })
}
export function useArchiveSkillMutation() {
  return useSkillMutation((input: SkillArchiveInput) => {
    const body = SkillArchiveInputSchema.parse(input)
    return apiClient.request(`${skillPath(body.workspaceId, body.skillId)}/archive`, SkillMutationResultSchema, { method: 'PUT', body })
  })
}

/** Agents still on an older version of this skill, and the workflows that use them. */
export function useSkillUsageQuery(workspaceId: string, skillId: string) {
  return useQuery({ queryKey: skillKeys.usage(workspaceId, skillId), retry: false,
    queryFn: ({ signal }) => apiClient.request(`${skillPath(workspaceId, skillId)}/usage`, SkillUsageSchema, { signal }) })
}
export function useUpdateSkillUsersMutation(workspaceId: string, skillId: string) {
  const client = useQueryClient()
  return useMutation({ retry: false,
    mutationFn: (commandId: string) => apiClient.request(`${skillPath(workspaceId, skillId)}/update-users`, SkillUsersUpdateResultSchema,
      { method: 'POST', body: { commandId } }),
    onSettled: () => client.invalidateQueries({ queryKey: skillKeys.usage(workspaceId, skillId) }) })
}
