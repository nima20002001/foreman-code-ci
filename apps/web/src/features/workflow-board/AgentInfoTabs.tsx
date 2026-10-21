import { useState, type ReactNode } from 'react'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { Tabs } from '../../shared/ui/nocturne'
import { Activities } from './Activities'

/** Agent Info: its details, and with a Run on the Board, that Agent's own Activity. */
export function AgentInfoTabs({ details, scope, agentId }: { details: ReactNode; scope?: RepeatGraphScopeV3; agentId: string }) {
  const [tab, setTab] = useState('details')
  if (!scope) return <>{details}</>
  return <Tabs label="Agent info" value={tab} onValueChange={setTab} keepMounted={false} items={[
    { value: 'details', label: 'Details', content: details },
    { value: 'activity', label: 'Activity', content: <Activities scope={scope} focusAgentId={agentId} /> },
  ]} />
}
