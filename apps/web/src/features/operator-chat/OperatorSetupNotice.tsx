import type { OperatorChatSetup } from '@foreman-code/contracts'
import { ExecutionReadinessNotice } from './ExecutionReadinessNotice'
import { Button } from '../../shared/ui/nocturne'
import { ChatNotice } from '../conversations/ChatNotice'

export function OperatorSetupNotice({ data, checking, failed, onRetry }: {
  data?: OperatorChatSetup; checking: boolean; failed: boolean; onRetry(): void;
}) {
  if (checking && !data) return null
  if (failed) return <ChatNotice title="Tool connection check failed"
    action={<Button size="sm" disabled={checking} onClick={onRetry}>Check again</Button>}>
    {data?.status === 'configured' ? 'The connection was configured at the last successful check.'
      : 'Check the tool connection before sending a message.'}
  </ChatNotice>
  if (!data) return null
  if (data.harness === 'opencode') return <ChatNotice title="Retired harness (OpenCode): read-only" tone="info" />
  if (data.status === 'configured') return <ExecutionReadinessNotice harness={data.harness} configurationVersionId={data.configurationVersionId} />
  const name = data.harness === 'claude' ? 'Claude' : 'Codex'
  return <ChatNotice title={`Install Foreman Code MCP in ${name} first`}
    action={<><a className="n-button n-button--secondary n-button--sm"
      href={`/settings/harnesses?harness=${data.harness}&section=connections`}>Open Harness Settings</a>
      <Button size="sm" disabled={checking} loading={checking} onClick={onRetry}>Check again</Button></>}>
    {data.reason ?? "Operator chat needs the enabled Foreman Code MCP connection to use the app’s tools."}
  </ChatNotice>
}
