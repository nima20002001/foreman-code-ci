import { DomainError } from '../errors.js'

export interface InteractionResponseOptions { signal?: AbortSignal | undefined }

export function assertInteractionResponseActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DomainError('MCP_REQUEST_CANCELLED', 'The request was cancelled before the decision committed.', 409)
  }
}
