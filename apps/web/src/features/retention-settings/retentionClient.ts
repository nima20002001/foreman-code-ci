import {
  FileRetentionGetResultSchema,
  FileRetentionPreviewInputSchema,
  FileRetentionPreviewResultSchema,
  FileRetentionSaveInputSchema,
  FileRetentionSaveResultSchema,
  type FileRetentionPreviewInput,
  type FileRetentionSaveInput,
} from '@foreman-code/contracts/files'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'

const root = '/api/management/file-retention'

/** The authenticated session selects the owner. No workspace or owner selector is sent. */
export const retentionClient = {
  get(options?: RequestOptions) {
    return apiClient.request(root, FileRetentionGetResultSchema, options)
  },
  preview(input: FileRetentionPreviewInput, options?: RequestOptions) {
    return apiClient.request(`${root}/preview`, FileRetentionPreviewResultSchema, {
      ...options, method: 'POST', body: FileRetentionPreviewInputSchema.parse(input),
    })
  },
  async save(input: FileRetentionSaveInput) {
    const request = FileRetentionSaveInputSchema.parse(input)
    const result = await apiClient.request(root, FileRetentionSaveResultSchema, {
      method: 'POST', body: request,
    })
    const { preference, updatedFileCount, expiredNowCount } = result.value
    if (preference.durationSeconds !== request.durationSeconds
      || (request.expectedRevision !== undefined && preference.revision !== request.expectedRevision + 1)
      || (!request.applyToExisting && (updatedFileCount !== 0 || expiredNowCount !== 0))) {
      // A malformed acknowledgement is NOT evidence that the command failed.
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Could not verify the saved retention.' })
    }
    return result
  },
}
