import { useEffect, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  HarnessOptionsResultSchema, HarnessConfigurationCheckResultSchema,
  HarnessMcpListResultSchema, HarnessMcpPlansResultSchema, HarnessMcpPlanResultSchema,
  HarnessMcpManagedInputSchema, HarnessMcpReconcileInputSchema, type HarnessMcpReconcileInput, type HarnessMcpPlan,
  HarnessMcpPlanInputSchema, HarnessMcpPlanSchema, HarnessDirectoryBrowseResultSchema,
  WorkspaceFolderCreateInputSchema, WorkspaceFolderCreateResultSchema, type WorkspaceFolderCreateInput,
  WorkspaceFolderUndoInputSchema, WorkspaceFolderUndoResultSchema, type WorkspaceFolderUndoInput,
  WorkspaceFolderRenameInputSchema, WorkspaceFolderRenameResultSchema, type WorkspaceFolderRenameInput,
  type HarnessMcpPlanInput, type HarnessMcpManagedInput,
  CodexPluginListResultSchema, CodexPluginDetailResultSchema, CodexPluginChangeInputSchema, CodexPluginChangeResultSchema,
  type CodexPluginListInput, type CodexPluginChangeInput, type CodexPluginChangeResult, type CodexPluginReconcileInput,
  CodexPluginOperationsResultSchema, CodexPluginReconcileInputSchema,
} from '@foreman-code/contracts/management'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import { apiClient } from './client'
import { reservePluginOperation, restorePluginOperation, pluginOperationFailed, pluginOperationSucceeded, terminalPluginResult, type PluginOperation } from './codexPluginOperation'
import { sessionGeneration, sessionSignal, sessionIsSwitching, SessionChangedError } from './sessionBoundary'
import { managedMcpFailed, managedMcpSucceeded, reserveManagedMcpOperation, terminalMcpPlan, type ManagedMcpOperation } from './managedMcpOperation'
import { WorkspaceFolderDeleteInputSchema, WorkspaceFolderDeleteResultSchema, type WorkspaceFolderDeleteInput } from '@foreman-code/contracts/management'
import { ClaudeSetupOptionsSchema } from '@foreman-code/contracts/claude'

export function useClaudeSetupOptions(enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: [...harnessSettingsKeys.root, sessionGeneration(), 'claude', 'setup-options'], retry: false,
    enabled: enabled && !sessionIsSwitching(), queryFn: ({ signal }) => apiClient.request('/api/management/harnesses/claude/setup-options', ClaudeSetupOptionsSchema, { signal }) })
}

// Each abort rotates the existing session controller synchronously. Re-arm after rotation.
function subscribeSession(changed: () => void) {
  let active = true
  let signal = sessionSignal()
  const abort = () => queueMicrotask(() => {
    if (!active) return
    signal.removeEventListener('abort', abort)
    signal = sessionSignal()
    signal.addEventListener('abort', abort, { once: true })
    changed()
  })
  signal.addEventListener('abort', abort, { once: true })
  return () => { active = false; signal.removeEventListener('abort', abort) }
}
export function useHarnessSessionEpoch() { return useSyncExternalStore(subscribeSession, sessionGeneration, sessionGeneration) }

type Harness = HarnessConfiguration['harness']
export const harnessSettingsKeys = {
  root: ['workbench', 'management', 'harness-settings'] as const,
  options: (harness: Harness, hostRef?: DeviceProvisioningTarget['hostRef']) =>
    [...harnessSettingsKeys.root, sessionGeneration(), harness, 'options', ...(hostRef ? [hostRef] : [])] as const,
  check: (snapshot: string) => [...harnessSettingsKeys.root, 'check', sessionGeneration(), snapshot] as const,
  mcp: (harness: Harness) => [...harnessSettingsKeys.root, sessionGeneration(), harness, 'mcp'] as const,
  plans: (harness: Harness) => [...harnessSettingsKeys.root, sessionGeneration(), harness, 'plans'] as const,
  plugins: (input: CodexPluginListInput) => [...harnessSettingsKeys.root, sessionGeneration(), 'codex-plugins', input] as const,
  plugin: (pluginId: string) => [...harnessSettingsKeys.root, sessionGeneration(), 'codex-plugin', pluginId] as const,
}

export function useCodexPlugins(input: CodexPluginListInput, enabled = true) {
  useHarnessSessionEpoch()
  const client = useQueryClient()
  const queryKey = harnessSettingsKeys.plugins(input)
  const read = (signal: AbortSignal, options: { refresh?: boolean } = {}) => {
    const query = new URLSearchParams({
      view: input.view, query: input.query, offset: String(input.offset), limit: String(input.limit),
    })
    if (options.refresh || input.refresh) query.set('refresh', 'true')
    return apiClient.request(`/api/management/harnesses/codex/plugins?${query}`, CodexPluginListResultSchema, { signal })
  }
  const result = useQuery({ queryKey, enabled: enabled && !sessionIsSwitching(), retry: false,
    refetchOnWindowFocus: false, queryFn: ({ signal }) => read(signal) })
  const refresh = () => client.fetchQuery({ queryKey, staleTime: 0,
    queryFn: ({ signal }) => read(signal, { refresh: true }) })
  return { ...result, refresh }
}
export function useCodexPlugin(pluginId: string | undefined) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: harnessSettingsKeys.plugin(pluginId ?? ''), enabled: Boolean(pluginId) && !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => apiClient.request(`/api/management/harnesses/codex/plugins/${encodeURIComponent(pluginId!)}`,
      CodexPluginDetailResultSchema, { signal }) })
}
/** Operation identity belongs to the access session, not a mounted settings panel. */
export function useChangeCodexPlugin() {
  const client = useQueryClient()
  const epoch = useHarnessSessionEpoch()
  const key = [...harnessSettingsKeys.root, epoch, 'plugin-operation'] as const
  const operationsKey = [...harnessSettingsKeys.root, epoch, 'plugin-operations'] as const
  type State = { operation: PluginOperation | null; settled: string[] }
  const saved = useQuery<State>({ queryKey: key, queryFn: () => ({ operation: null, settled: [] }),
    enabled: false, initialData: { operation: null, settled: [] }, staleTime: Infinity, gcTime: Infinity })
  const operations = useQuery({ queryKey: operationsKey, enabled: !sessionIsSwitching(), retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => apiClient.request('/api/management/harnesses/codex/plugins/operations', CodexPluginOperationsResultSchema, { signal }) })
  const currentSession = () => epoch === sessionGeneration() && !sessionIsSwitching()
  const state = () => client.getQueryData<State>(key) ?? { operation: null, settled: [] }
  const identity = (value: { commandId: string; requestedBy?: string }) => `${value.requestedBy ?? ''}:${value.commandId}`
  const update = (id: string, transform: (current: PluginOperation) => PluginOperation | null, terminal = false) => {
    if (!currentSession()) return
    client.setQueryData<State>(key, (previous) => {
      const value = previous ?? { operation: null, settled: [] }
      if (value.operation?.commandId !== id) return value
      const operation = transform(value.operation)
      return { operation, settled: terminal ? [...value.settled, identity(value.operation), id] : value.settled }
    })
  }
  useEffect(() => {
    if (epoch !== sessionGeneration() || sessionIsSwitching() || !operations.isSuccess) return
    const records = operations.data.items
    client.setQueryData<State>([...harnessSettingsKeys.root, epoch, 'plugin-operation'], (previous) => {
      const value = previous ?? { operation: null, settled: [] }
      // Merge server ownership into a locally retained command, never replace its payload.
      if (value.operation) {
        const matching = records.find((item) => item.commandId === value.operation?.commandId)
        return matching && !value.operation.requestedBy
          ? { ...value, operation: { ...value.operation, requestedBy: matching.requestedBy } } : value
      }
      const next = records.find((item) => !value.settled.includes(identity(item)) && !value.settled.includes(item.commandId))
      return next ? { ...value, operation: restorePluginOperation(next) } : value
    })
  }, [client, epoch, operations.data, operations.isSuccess])
  const invalidate = async () => {
    if (currentSession()) await client.invalidateQueries({ queryKey: harnessSettingsKeys.root })
  }
  const settle = (result: CodexPluginChangeResult, id: string) => {
    update(id, (current) => pluginOperationSucceeded(current, result), terminalPluginResult(result))
    if (currentSession() && terminalPluginResult(result)) client.setQueryData(operationsKey,
      (previous: { items: Array<{ commandId: string }> } | undefined) => previous ? { ...previous, items: previous.items.filter((item) => item.commandId !== id) } : previous)
  }
  const mutation = useMutation({ retry: false,
    mutationFn: (input: CodexPluginChangeInput) => {
      if (!currentSession()) throw new SessionChangedError()
      if (JSON.stringify(state().operation?.input) !== JSON.stringify(input)) throw new Error('The original plugin request is no longer reserved.')
      return apiClient.request('/api/management/harnesses/codex/plugins/change', CodexPluginChangeResultSchema,
        { method: 'POST', body: CodexPluginChangeInputSchema.parse(input) })
    },
    // These callbacks still run after the panel unmounts.
    onSuccess: (result, input) => settle(result, input.commandId),
    onError: (error, input) => update(input.commandId, (current) => pluginOperationFailed(current, error)),
    onSettled: invalidate,
  })
  const reconciliation = useMutation({ retry: false,
    mutationFn: (input: CodexPluginReconcileInput) => {
      if (!currentSession() || state().operation?.commandId !== input.commandId) throw new SessionChangedError()
      return apiClient.request('/api/management/harnesses/codex/plugins/reconcile', CodexPluginChangeResultSchema,
        { method: 'POST', body: CodexPluginReconcileInputSchema.parse(input) })
    },
    onSuccess: (result, input) => settle(result, input.commandId),
    onError: (error, input) => update(input.commandId, (current) => ({ ...current, phase: 'review', error: error.message })),
    onSettled: invalidate,
  })
  const start = (draft: Omit<CodexPluginChangeInput, 'commandId'>) => {
    if (!currentSession() || state().operation || !operations.isSuccess || operations.isFetching) return
    if (operations.data.items.some((item) => !state().settled.includes(item.commandId))) return
    const input = CodexPluginChangeInputSchema.parse({ ...draft, commandId: crypto.randomUUID() })
    client.setQueryData<State>(key, { ...state(), operation: reservePluginOperation(input) })
    mutation.mutate(input)
  }
  const retry = () => {
    const current = state().operation
    if (!currentSession() || !current?.input || current.requestedBy || current.phase === 'sending' || reconciliation.isPending) return
    update(current.commandId, (value) => ({ ...value, phase: 'sending' }))
    mutation.mutate(current.input)
  }
  const reconcile = (acceptObservedState = false) => {
    const current = state().operation
    if (!currentSession() || !current || current.phase === 'sending' || reconciliation.isPending) return
    const revision = current.result?.observedRevision
    if (acceptObservedState && !revision) return
    reconciliation.mutate({ commandId: current.commandId, ...(current.requestedBy ? { requestedBy: current.requestedBy } : {}),
      acceptObservedState, ...(acceptObservedState && revision ? { expectedRevision: revision } : {}) })
  }
  return { ...mutation, operation: saved.data.operation, operations, start, retry, reconcile,
    reconciliation, busy: saved.data.operation?.phase === 'sending' || reconciliation.isPending }
}

export function useNativeHarnessOptions(harness: Harness, enabled = true, hostRef?: DeviceProvisioningTarget['hostRef']) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: harnessSettingsKeys.options(harness, hostRef), enabled: enabled && !sessionIsSwitching(), staleTime: 300_000, retry: false,
    refetchOnWindowFocus: true,
    queryFn: ({ signal }) => {
      const query = hostRef ? `?${new URLSearchParams({ hostRef: JSON.stringify(hostRef) })}` : ''
      return apiClient.request(`/api/management/harnesses/${harness}/options${query}`, HarnessOptionsResultSchema, { signal })
    },
  })
}

/** Exact drafts have distinct cache keys. A late result can never qualify a newer selection. */
export function useAutomaticHarnessCheck(configuration: HarnessConfiguration | undefined) {
  useHarnessSessionEpoch()
  const snapshot = configuration ? JSON.stringify(configuration) : ''
  const [settled, setSettled] = useState(snapshot)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(snapshot), 400)
    return () => clearTimeout(timer)
  }, [snapshot])
  const result = useQuery({ queryKey: harnessSettingsKeys.check(settled),
    enabled: !sessionIsSwitching() && Boolean(settled) && snapshot === settled, staleTime: 300_000, retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => apiClient.request('/api/management/harnesses/validate', HarnessConfigurationCheckResultSchema,
      { method: 'POST', body: { configuration: JSON.parse(settled) as HarnessConfiguration }, signal }),
  })
  return { result, current: Boolean(snapshot) && snapshot === settled }
}

export function useRefreshNativeHarness(harness: Harness, refresh: 'catalog' | 'upstream' = 'catalog') {
  const client = useQueryClient()
  const epoch = useHarnessSessionEpoch()
  return useMutation({ retry: false,
    mutationFn: () => {
      if (epoch !== sessionGeneration() || sessionIsSwitching()) throw new SessionChangedError()
      return apiClient.request(`/api/management/harnesses/${harness}/refresh`, HarnessOptionsResultSchema, { method: 'POST', body: { refresh } })
    },
    onSuccess: (data) => {
      if (epoch !== sessionGeneration() || sessionIsSwitching()) return
      client.setQueryData(harnessSettingsKeys.options(data.harness), data)
    },
    onSettled: async () => {
      if (epoch !== sessionGeneration() || sessionIsSwitching()) return
      await Promise.all([
        client.invalidateQueries({ queryKey: [...harnessSettingsKeys.root, 'check', epoch] }),
        client.invalidateQueries({ queryKey: ['workbench', 'management', 'harnesses'] }),
        client.invalidateQueries({ queryKey: ['operator-chat', 'setup'] }),
      ])
    },
  })
}

export function useNativeMcpServers(harness: Harness, enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: harnessSettingsKeys.mcp(harness), enabled: enabled && !sessionIsSwitching(), staleTime: 30_000, retry: false,
    refetchOnWindowFocus: false, refetchInterval: enabled ? 10_000 : false,
    queryFn: ({ signal }) => apiClient.request(`/api/management/harnesses/${harness}/mcp`, HarnessMcpListResultSchema, { signal }),
  })
}
export function useNativeMcpPlans(harness: Harness, enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: harnessSettingsKeys.plans(harness), enabled: enabled && !sessionIsSwitching(), retry: false,
    refetchInterval: enabled ? 10_000 : false,
    queryFn: ({ signal }) => apiClient.request(`/api/management/harnesses/${harness}/mcp/plans`, HarnessMcpPlansResultSchema, { signal }),
  })
}
export function useRequestNativeMcpChange() {
  const client = useQueryClient()
  return useMutation({ retry: false,
    mutationFn: (input: HarnessMcpPlanInput) => apiClient.request('/api/management/harnesses/mcp/plans', HarnessMcpPlanResultSchema,
      { method: 'POST', body: HarnessMcpPlanInputSchema.parse(input) }),
    onSuccess: async (data) => { await client.invalidateQueries({ queryKey: harnessSettingsKeys.plans(data.value.harness) }) },
  })
}
function cachedPlanHarness(client: QueryClient, planId: string): Harness | undefined {
  for (const query of client.getQueryCache().findAll({ queryKey: harnessSettingsKeys.root })) {
    if (query.queryKey.at(-1) !== 'plans') continue
    const plans = query.state.data as { items: HarnessMcpPlan[] } | undefined
    const plan = plans?.items.find((value) => value.id === planId)
    if (plan) return plan.harness
  }
  return undefined
}
async function refreshMcpReadback(client: QueryClient, epoch: number, harness?: Harness) {
  if (epoch !== sessionGeneration() || sessionIsSwitching()) return
  // Readiness changes in the background; unrelated model discovery is unchanged.
  void Promise.all([
    client.invalidateQueries({ queryKey: ['workbench', 'management', 'harnesses'] }),
    client.invalidateQueries({ queryKey: ['operator-chat', 'setup'] }),
    client.invalidateQueries({ queryKey: [...harnessSettingsKeys.root, 'check', epoch], predicate: (query) => {
      const snapshot = query.queryKey.at(-1)
      return Boolean(snapshot) && (!harness || (JSON.parse(String(snapshot)) as HarnessConfiguration).harness === harness)
    } }),
  ]).catch(error => { console.warn('Could not refresh harness settings.', error) })
  // Keep mutations pending until affected native revision/plan readback settles.
  await client.invalidateQueries({ queryKey: [...harnessSettingsKeys.root, epoch, ...(harness ? [harness] : [])],
    predicate: (query) => ['mcp', 'plans'].includes(String(query.queryKey.at(-1))) })
}
export function useDecideNativeMcpChange() {
  const client = useQueryClient()
  const epoch = useHarnessSessionEpoch()
  return useMutation({ retry: false,
    mutationFn: (input: { planId: string; approve: boolean }) => apiClient.request('/api/management/harnesses/mcp/decision', HarnessMcpPlanSchema,
      { method: 'POST', body: input }),
    onSuccess: (plan) => {
      if (epoch !== sessionGeneration() || sessionIsSwitching()) return
      client.setQueryData<{ items: HarnessMcpPlan[] }>(harnessSettingsKeys.plans(plan.harness), (current) => {
        const observed = current?.items.find((item) => item.id === plan.id)
        if (observed && terminalMcpPlan(observed)) return current
        return { items: [plan, ...(current?.items.filter((item) => item.id !== plan.id) ?? [])] }
      })
      settleManagedOperation(client, epoch, plan)
    },
    onSettled: (plan, _error, input) => refreshMcpReadback(client, epoch, plan?.harness ?? cachedPlanHarness(client, input.planId)),
  })
}
const managedOperationKey = (harness: Harness, epoch: number) => [...harnessSettingsKeys.root, epoch, harness, 'managed-operation'] as const
type ManagedStart = HarnessMcpManagedInput extends infer Input ? Input extends { commandId: string; harness: Harness }
  ? Omit<Input, 'commandId' | 'harness'> : never : never
function settleManagedOperation(client: QueryClient, epoch: number, plan: HarnessMcpPlan) {
  if (!terminalMcpPlan(plan) || epoch !== sessionGeneration() || sessionIsSwitching()) return
  const key = managedOperationKey(plan.harness, epoch)
  const current = client.getQueryData<ManagedMcpOperation | null>(key)
  if (current?.plan?.id === plan.id) client.setQueryData(key, null)
}

/** Query-client/session lifetime, not the mounted harness panel's lifetime. */
export function useApplyManagedMcpChange(harness: Harness, observedPlans?: HarnessMcpPlan[]) {
  const client = useQueryClient()
  const epoch = useHarnessSessionEpoch()
  const key = managedOperationKey(harness, epoch)
  const stored = useQuery<ManagedMcpOperation | null>({ queryKey: key, queryFn: () => null,
    enabled: false, initialData: null, staleTime: Infinity, gcTime: Infinity })
  useEffect(() => {
    for (const plan of observedPlans ?? []) settleManagedOperation(client, epoch, plan)
  }, [client, epoch, observedPlans])
  const currentSession = () => epoch === sessionGeneration() && !sessionIsSwitching()
  const update = (input: HarnessMcpManagedInput, transform: (value: ManagedMcpOperation) => ManagedMcpOperation | null) => {
    if (!currentSession()) return
    client.setQueryData<ManagedMcpOperation | null>(key, (current) => current?.input.commandId === input.commandId ? transform(current) : current ?? null)
  }
  const mutation = useMutation({ retry: false,
    mutationFn: (input: HarnessMcpManagedInput) => {
      if (!currentSession()) throw new SessionChangedError()
      const saved = client.getQueryData<ManagedMcpOperation | null>(key)
      if (!saved || JSON.stringify(saved.input) !== JSON.stringify(input)) throw new Error('The original MCP operation is no longer reserved.')
      return apiClient.request('/api/management/harnesses/mcp/managed', HarnessMcpPlanSchema,
        { method: 'POST', body: HarnessMcpManagedInputSchema.parse(input) })
    },
    // Hook-level callbacks run even if a panel unmounts before HTTP settles.
    onSuccess: (plan, input) => update(input, (current) => managedMcpSucceeded(current, plan)),
    onError: (error, input) => update(input, (current) => managedMcpFailed(current, error)),
    onSettled: (_plan, _error, input) => refreshMcpReadback(client, epoch, input.harness),
  })
  const start = (value: ManagedStart) => {
    if (!currentSession()) return
    if (client.getQueryData<ManagedMcpOperation | null>(key)) return // Never replace an unresolved operation.
    const input = HarnessMcpManagedInputSchema.parse({ ...value, harness, commandId: crypto.randomUUID() })
    client.setQueryData(key, reserveManagedMcpOperation(input))
    mutation.mutate(input)
  }
  const retry = () => {
    const current = client.getQueryData<ManagedMcpOperation | null>(key)
    if (!currentSession() || !current || current.phase === 'sending' || current.phase === 'review') return
    client.setQueryData(key, { ...current, phase: 'sending' })
    mutation.mutate(current.input) // The original revision, payload and ID survive every panel remount.
  }
  return { ...mutation, operation: stored.data, start, retry }
}

export function useReconcileNativeMcpChange() {
  const client = useQueryClient()
  const epoch = useHarnessSessionEpoch()
  return useMutation({ retry: false,
    mutationFn: (input: HarnessMcpReconcileInput) => apiClient.request('/api/management/harnesses/mcp/reconcile', HarnessMcpPlanResultSchema,
      { method: 'POST', body: HarnessMcpReconcileInputSchema.parse(input) }),
    onSuccess: (result) => settleManagedOperation(client, epoch, result.value),
    onSettled: (result, _error, input) => refreshMcpReadback(client, epoch, result?.value.harness ?? cachedPlanHarness(client, input.planId)),
  })
}
export function useHarnessDirectories(input: { rootId?: string; path?: string; cursor?: string }, enabled: boolean) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: [...harnessSettingsKeys.root, sessionGeneration(), 'directories', input], enabled: enabled && !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, value)
      return apiClient.request(`/api/management/harnesses/directories?${query}`, HarnessDirectoryBrowseResultSchema, { signal })
    },
  })
}


export function useCreateWorkspaceFolder() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: WorkspaceFolderCreateInput) => apiClient.request('/api/management/harnesses/directories',
      WorkspaceFolderCreateResultSchema, { method: 'POST', body: WorkspaceFolderCreateInputSchema.parse(input) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: harnessSettingsKeys.root }).catch(error => { console.warn('Could not refresh harness settings.', error) }) },
  })
}


export function useRenameWorkspaceFolder() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: WorkspaceFolderRenameInput) => apiClient.request('/api/management/harnesses/directories/rename',
      WorkspaceFolderRenameResultSchema, { method: 'POST', body: WorkspaceFolderRenameInputSchema.parse(input) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: harnessSettingsKeys.root }).catch(error => { console.warn('Could not refresh harness settings.', error) }) },
  })
}

export function useUndoWorkspaceFolder() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: WorkspaceFolderUndoInput) => apiClient.request('/api/management/harnesses/directories/undo',
      WorkspaceFolderUndoResultSchema, { method: 'POST', body: WorkspaceFolderUndoInputSchema.parse(input) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: harnessSettingsKeys.root }) },
  })
}

export function useDeleteWorkspaceFolders() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: WorkspaceFolderDeleteInput) => apiClient.request('/api/management/harnesses/directories/delete',
      WorkspaceFolderDeleteResultSchema, { method: 'POST', body: WorkspaceFolderDeleteInputSchema.parse(input) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: harnessSettingsKeys.root }) },
  })
}
