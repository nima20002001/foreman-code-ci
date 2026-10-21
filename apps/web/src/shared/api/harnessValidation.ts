import { useMutation } from '@tanstack/react-query'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import {
  HarnessConfigurationCheckInputSchema, HarnessConfigurationCheckResultSchema,
} from '@foreman-code/contracts/management'
import { apiClient } from './client'

/** Read-only native inspection of an exact candidate. It starts no model turn and writes no defaults. */
export function useValidateHarnessConfiguration() {
  return useMutation({
    mutationFn: (configuration: HarnessConfiguration) => apiClient.request(
      '/api/management/harnesses/validate', HarnessConfigurationCheckResultSchema,
      { method: 'POST', body: HarnessConfigurationCheckInputSchema.parse({ configuration }) },
    ),
  })
}
