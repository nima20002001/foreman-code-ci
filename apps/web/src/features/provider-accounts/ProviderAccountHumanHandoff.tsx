import { useEffect, useRef, useState } from 'react'
import type { ProviderAccountAuthenticationOperation, ProviderAccountHumanHandoff } from '@foreman-code/contracts/provider-accounts'
import { Alert, Button } from '../../shared/ui/nocturne'
import { providerAccountsClient } from './providerAccountsClient'

/** Human instructions live only while this surface is visible, outside server-state caches. */
export function ProviderAccountHumanHandoff({ operation }: { operation: ProviderAccountAuthenticationOperation }) {
  const [handoff, setHandoff] = useState<ProviderAccountHumanHandoff>()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => request.current?.abort(), [])
  async function read() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setFailed(false)
    setHandoff(undefined)
    try {
      const result = await providerAccountsClient.handoff({ operationId: operation.id, target: operation.binding.target },
        { signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.operationId !== operation.id || Date.parse(result.expiresAt) <= Date.now()) {
        setFailed(true)
        return
      }
      setHandoff(result)
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }
  useEffect(() => {
    if (!handoff) return
    const timer = setTimeout(() => setHandoff(undefined), Math.max(0, Date.parse(handoff.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [handoff])
  return <div>
    {handoff ? <p role="status">{handoff.message}</p> : null}
    <Button disabled={pending} onClick={() => void read()}>
      {pending ? 'Reading sign-in instructions…' : 'Show sign-in instructions'}
    </Button>
    {failed ? <Alert tone="danger" live title="Sign-in instructions are unavailable. Recheck the original operation." /> : null}
  </div>
}
