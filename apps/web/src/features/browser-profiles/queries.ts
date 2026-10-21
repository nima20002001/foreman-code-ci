import { useQuery } from '@tanstack/react-query'
import { BrowserProfileSchema, BrowserProfileReplicaSchema, BrowserProfileSyncJobSchema } from '@foreman-code/contracts/browser-profiles'
import type { BrowserProfilesPort } from './types'

export const browserProfilesKey = (authBoundary: string) => ['browser-profiles', authBoundary] as const

export function useBrowserProfiles(port: BrowserProfilesPort, authBoundary: string, visible: boolean) {
  return useQuery({ queryKey: browserProfilesKey(authBoundary), enabled: visible,
    queryFn: async ({ signal }) => {
      const catalog = await port.readCatalog(signal)
      const presentReplicas = catalog.presentReplicas.filter(copy => catalog.replicas.some(replica =>
        replica.profileId === copy.profileId && replica.computerId === copy.computerId))
      return { profiles: catalog.profiles.map(profile => BrowserProfileSchema.parse(profile)),
        replicas: catalog.replicas.map(replica => BrowserProfileReplicaSchema.parse(replica)), presentReplicas,
        pendingReplicas: catalog.pendingReplicas }
    }, retry: false, refetchOnWindowFocus: false,
    refetchInterval: query => query.state.data?.pendingReplicas.length ? 1500 : false,
    refetchIntervalInBackground: false })
}

export function useBrowserProfileSync(port: BrowserProfilesPort, authBoundary: string, jobId: string | null, visible: boolean) {
  return useQuery({ queryKey: ['browser-profile-sync', authBoundary, jobId], enabled: visible && jobId !== null,
    queryFn: async ({ signal }) => {
      const job = BrowserProfileSyncJobSchema.parse(await port.readSync(jobId!, signal))
      if (job.id !== jobId) throw new Error('The profile sync response did not match this job.')
      return job
    }, retry: false, refetchOnWindowFocus: false,
    // Only this mounted job view reconciles unfinished work. Hidden/terminal views do no polling.
    refetchInterval: query => query.state.data && ['queued', 'running'].includes(query.state.data.state) ? 1500 : false,
    refetchIntervalInBackground: false })
}
