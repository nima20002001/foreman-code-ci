import { useEffect, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { BrowserPrepareResultSchema } from '@foreman-code/contracts/browser-sessions'
import { Button } from '../../shared/ui/nocturne'
import { browserErrorMessage, browserRequestUncertain } from './errors'
import { sameSubject } from './identity'
import type { AgentSubject, BrowserPrepareResult, BrowserUiPort, NodeBrowserSettings } from './types'

/** D's accepted lifecycle supplies this exact canonical result/request; rendering never prepares. */
export interface BrowserPreparationRead {
  result: BrowserPrepareResult
  request: { subject: AgentSubject; browser: NodeBrowserSettings; computerId: string; commandId: string }
}

const reasonLabels: Record<Extract<BrowserPrepareResult, { kind: 'unavailable' }>['reason'], string> = {
  disabled: 'Browser is disabled for this accepted node configuration.',
  profile_missing: 'The selected browser profile is not available on this computer.',
  computer_offline: 'The selected execution computer is offline.',
  runtime_missing: 'The managed browser runtime is not ready on this computer.',
  sign_in_required: 'This website needs a sign-in in the selected profile.',
  resource_pressure: 'The computer does not have capacity for another browser yet.',
  profile_busy: 'The selected profile is busy. Waiting for its owned browser work to finish.',
}

export function BrowserPreparation({ read, subject, port, historical, onSelectSession, onDenied }: {
  read: BrowserPreparationRead; subject: AgentSubject; port: BrowserUiPort; historical: boolean
  onSelectSession(sessionId: string): void; onDenied(error: unknown): void
}) {
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const retry = useMutation({ mutationFn: async () => {
    if (!sameSubject(read.request.subject, subject)) throw new Error('The preparation belongs to a different accepted agent.')
    const result = BrowserPrepareResultSchema.parse(await port.prepare(read.request.subject, read.request.browser,
      read.request.computerId, read.request.commandId))
    if (result.kind === 'ready' && (!result.session.subject || !sameSubject(result.session.subject, subject)
      || result.session.computerId !== read.request.computerId || result.control.sessionId !== result.session.id)) {
      throw new Error('The prepared browser does not match this accepted agent and computer.')
    }
    return result
  }, retry: false, onError: error => { if (mounted.current) onDenied(error) } })
  if (!sameSubject(read.request.subject, subject)) return <p>Browser preparation is unavailable for this selection.</p>
  const result = retry.data ?? BrowserPrepareResultSchema.parse(read.result)
  const unknown = retry.isError && browserRequestUncertain(retry.error)
  return <div aria-label="Browser preparation">
    {result.kind === 'unavailable' ? <><p role="status">{reasonLabels[result.reason]}</p>
      {!historical && result.retryable ? <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
        {retry.isPending ? 'Checking browser…' : unknown ? 'Check original browser preparation' : 'Retry browser'}
      </Button> : null}</> : <Button onClick={() => {
        if (result.session.subject && sameSubject(result.session.subject, subject)) onSelectSession(result.session.id)
      }}>Open prepared browser</Button>}
    {retry.error ? <p role="alert">{browserErrorMessage(retry.error)}</p> : null}
  </div>
}
