import { DomainError } from '../../modules/errors.js'
import { toolFailure, toolResult } from '../shared/results.js'
import type { AppRequestContext } from './types.js'

export async function invokeAppTool(
  context: AppRequestContext,
  name: string,
  work: () => Promise<unknown>,
) {
  try {
    return toolResult(await work())
  } catch (error) {
    if (error instanceof DomainError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      // Authorization is rechecked by the application service on every call.
      // Do not add target details to the error body or audit metadata here.
    }
    return toolFailure(error, 'The App MCP service could not complete the request.')
  }
}
