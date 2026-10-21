import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { boardStartClient, type BoardStartInput } from './startClient'
import { acknowledgeBoardStart, readBoardStart } from './startOutbox'

export async function recoverBoardStart(key: string, request: BoardStartInput) {
  const generation = sessionGeneration()
  const retained = readBoardStart(key)
  if (!retained || !sameWorkflowValue(retained, request)) throw new Error('The pending Start changed. Refresh before recovery.')
  const result = await boardStartClient.resolve(request)
  assertSession(generation)
  const acknowledgement = await acknowledgeBoardStart(key, request)
  return { result, acknowledgement }
}
