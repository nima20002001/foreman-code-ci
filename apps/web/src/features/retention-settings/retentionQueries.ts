import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  FileRetentionGetResult, FileRetentionPreviewInput, FileRetentionSaveResult,
} from '@foreman-code/contracts/files'
import { attachmentLifecycleQueryKey } from '../attachments/attachmentLifecycle'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { retentionClient } from './retentionClient'
import { retainRetentionCommand, retentionCommandKey, settleRetentionCommand, type RetentionCommand } from './retentionCommand'

export const retentionQueryKey = (generation: number) => ['file-retention', generation] as const

function preferenceOptions(generation: number) {
  return {
    queryKey: retentionQueryKey(generation),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      assertSession(generation)
      return retentionClient.get({ signal })
    },
    retry: false as const,
    staleTime: 0,
    structuralSharing: (previous: unknown, value: unknown) => {
      const incoming = value as FileRetentionGetResult
      const old = previous as FileRetentionGetResult | undefined
      return old?.preference.ownerPrincipalId === incoming.preference.ownerPrincipalId
        && old.preference.revision > incoming.preference.revision ? old : incoming
    },
  }
}

export function useRetentionPreferenceQuery() {
  return useQuery({ ...preferenceOptions(sessionGeneration()), enabled: !sessionIsSwitching() })
}

/** Cancel pre-write reads before fetching current truth; a replay receipt may be historical. */
export async function readRetentionPreference(client: QueryClient, generation: number) {
  assertSession(generation)
  await client.cancelQueries({ queryKey: retentionQueryKey(generation), exact: true })
  assertSession(generation)
  return client.fetchQuery(preferenceOptions(generation))
}

// These two fields are local response-binding expectations, never HTTP selectors.
interface PreviewAttempt {
  input: FileRetentionPreviewInput
  ownerPrincipalId: string
  expectedRevision: number
}

export function useRetentionPreviewMutation() {
  return useMutation({
    mutationKey: ['file-retention-preview', sessionGeneration()],
    retry: false,
    networkMode: 'always',
    mutationFn: async ({ input, ownerPrincipalId, expectedRevision }: PreviewAttempt) => {
      const result = await retentionClient.preview(input)
      if (result.ownerPrincipalId !== ownerPrincipalId || result.durationSeconds !== input.durationSeconds) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Could not verify the file count.' })
      }
      if (result.preferenceRevision !== expectedRevision) {
        throw new ApiError({ code: 'REVISION_CONFLICT', message: 'Retention changed elsewhere.' }, 409)
      }
      return result
    },
  })
}

/** Match the shared CommandAttempt policy: only structured definitive 4xx rejects clear a command. */
function definitelyRejected(error: unknown) {
  return ApiError.is(error) && (error.code === 'INVALID_REQUEST'
    || (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
      && error.code !== 'HTTP_ERROR' && error.code !== 'INVALID_RESPONSE'))
}

export function useRetentionSaveMutation() {
  const client = useQueryClient()
  const generation = sessionGeneration()
  return useMutation({
    mutationKey: ['file-retention-save', generation],
    retry: false,
    networkMode: 'always',
    mutationFn: async ({ input, draft, ownerPrincipalId }: RetentionCommand & { ownerPrincipalId: string }) => {
      assertSession(generation)
      const key = retentionCommandKey(ownerPrincipalId)
      const recovering = retainRetentionCommand(key, { input, draft })
      let receipt: FileRetentionSaveResult
      try {
        receipt = await retentionClient.save(input)
      } catch (error) {
        assertSession(generation)
        if (definitelyRejected(error)) {
          // A denied/busy replay cannot disprove the original commit. Only a
          // receipt-aware revision conflict resolves an already uncertain command.
          if (recovering && !(ApiError.is(error) && error.code === 'REVISION_CONFLICT')) {
            throw new ApiError({ code: 'RETENTION_READBACK_UNKNOWN', message: 'Could not resolve the original save.' }, undefined, { cause: error })
          }
          try { settleRetentionCommand(key, input.commandId) } catch {
            throw new ApiError({ code: 'RETENTION_READBACK_UNKNOWN', message: 'Could not resolve the save.' })
          }
        }
        throw error
      }
      assertSession(generation)
      if (receipt.value.preference.ownerPrincipalId !== ownerPrincipalId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Could not verify the retention owner.' })
      }
      if (input.applyToExisting) {
        // Refresh file truth, not a locally computed expiry based on the preference.
        void client.invalidateQueries({ queryKey: attachmentLifecycleQueryKey }).catch(() => /* ignore: the next read refetches */ undefined)
      }
      try {
        const current = await readRetentionPreference(client, generation)
        assertSession(generation)
        if (current.preference.ownerPrincipalId !== ownerPrincipalId
          || current.preference.revision < receipt.value.preference.revision) throw new Error('Stale readback')
        settleRetentionCommand(key, input.commandId)
        return current
      } catch {
        // A failing GET, even a 4xx, does not reject the preceding successful POST.
        throw new ApiError({ code: 'RETENTION_READBACK_UNKNOWN', message: 'Could not verify the save. Retry safely.' })
      }
    },
  })
}
