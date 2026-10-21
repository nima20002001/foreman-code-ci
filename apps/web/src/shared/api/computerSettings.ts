import { sameComputer } from './sameComputer'
import { z } from 'zod'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { DevicePairingGrantInputSchema, DevicePairingGrantResultSchema, DeviceRevokeInputSchema, DeviceRegistrationSchema, DeviceListResultSchema, MainDeviceIdentityPublicSchema } from '@foreman-code/contracts/device-identity'
import { HarnessHostReferenceSchema, HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import { DeviceSetupApproveInputSchema, DeviceSetupApproveResultSchema, DeviceSetupOptionsSchema } from '@foreman-code/contracts/device-setup'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const computerSettingsKeys = {
  root: ['workbench', 'computer-settings'] as const,
  main: () => [...computerSettingsKeys.root, sessionGeneration(), 'main'] as const,
  devices: (mainId: string) => [...computerSettingsKeys.root, sessionGeneration(), mainId, 'devices'] as const,
  setupOptions: (mainId: string) => [...computerSettingsKeys.root, sessionGeneration(), mainId, 'setup-options'] as const,
  inventory: (host: CanonicalMachineReference, applicationInstallationId?: string) => [...computerSettingsKeys.root, sessionGeneration(), host, applicationInstallationId ?? null, 'harness-registry'] as const,
}
export function useSelectedMainQuery() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: computerSettingsKeys.main(), enabled: !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => apiClient.request('/api/devices/main', MainDeviceIdentityPublicSchema, { signal }) })
}
export function useRegisteredComputersQuery(mainId: string | undefined) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: computerSettingsKeys.devices(mainId ?? ''), refetchInterval: 5_000, enabled: Boolean(mainId) && !sessionIsSwitching(), retry: false,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request('/api/devices', DeviceListResultSchema, { signal })
      if (result.devices.some(value => value.mainId !== mainId)) throw new Error('Computer readback belongs to a different main installation.')
      return result
    } })
}
export function useHostHarnessRegistryQuery(host: CanonicalMachineReference | undefined, applicationInstallationId?: string,
  options?: { refetchInterval?: number }) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: host ? computerSettingsKeys.inventory(host, applicationInstallationId) : [...computerSettingsKeys.root, sessionGeneration(), 'unselected'],
    enabled: Boolean(host) && !sessionIsSwitching(), retry: false, staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
    queryFn: async ({ signal }) => {
      const value = HarnessHostReferenceSchema.parse(host)
      const query = new URLSearchParams({ kind: value.kind, mainId: value.mainId, ...(value.kind === 'device' ? { deviceId: value.deviceId } : {}) })
      const result = await apiClient.request(`/api/management/harnesses/registry?${query}`, HarnessRegistryReadbackSchema, { signal })
      if (result.installations.some(installation => !sameComputer(installation.hostRef, value))
        || result.hostMetadata && (!sameComputer(result.hostMetadata.hostRef, value) || applicationInstallationId && result.hostMetadata.applicationInstallationId !== applicationInstallationId))
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Harness inventory belongs to another computer.' })
      return result
    } })
}

export function useCreateComputerPairingGrant(mainId: string) {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...computerSettingsKeys.root, sessionGeneration(), mainId, 'pairing-grant'],
    mutationFn: async (input: z.input<typeof DevicePairingGrantInputSchema>) => {
      const result = await apiClient.request('/api/devices/pairing-grants', DevicePairingGrantResultSchema,
        { method: 'POST', body: DevicePairingGrantInputSchema.parse(input) })
      if (result.registration.mainId !== mainId) throw new Error('Pairing grant belongs to a different main.')
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: computerSettingsKeys.root }),
  })
}
/** The device endpoint is server-configured; it is never derived from the browser address. */
export function useComputerSetupOptionsQuery(mainId: string) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: computerSettingsKeys.setupOptions(mainId), enabled: !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => apiClient.request('/api/devices/setup-options', DeviceSetupOptionsSchema, { signal }) })
}
/** The result carries a private enrollment code; keep it in the mutation result only. */
export function useApproveComputerSetup(mainId: string) {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...computerSettingsKeys.root, sessionGeneration(), mainId, 'setup-code'],
    mutationFn: async (input: z.input<typeof DeviceSetupApproveInputSchema>) => {
      const result = await apiClient.request('/api/devices/setup-codes', DeviceSetupApproveResultSchema,
        { method: 'POST', body: DeviceSetupApproveInputSchema.parse(input) })
      if (result.registration.mainId !== mainId) throw new Error('Computer approval belongs to a different main.')
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: computerSettingsKeys.root }),
  })
}
export function useRevokeComputer() {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...computerSettingsKeys.root, sessionGeneration(), 'revoke'],
    mutationFn: async (input: z.input<typeof DeviceRevokeInputSchema>) => {
      const result = await apiClient.request('/api/devices/revoke', DeviceRegistrationSchema,
        { method: 'POST', body: DeviceRevokeInputSchema.parse(input) })
      if (result.deviceId !== input.deviceId || result.status !== 'revoked')
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Revocation was not confirmed for this worker.' })
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: computerSettingsKeys.root }),
  })
}
