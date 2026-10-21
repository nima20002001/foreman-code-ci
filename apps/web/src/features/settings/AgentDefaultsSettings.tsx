import { useState } from 'react'
import { agentTemplateForRole, nativeToolsSummary, type AgentDefaults } from '@foreman-code/contracts'
import type { SettingsAgentRole } from '@foreman-code/contracts/management'
import { ErrorState, LoadingState, Switch } from '../../shared/ui/nocturne'
import { useAgentDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { askOperator } from '../operator-chat/operatorChatStore'
import { SettingsChoice, SettingsOverview } from './SettingsCards'
import { agentRoleOrder, harnessSummary, rolePresentation } from './settingsPresentation'
import { PromptSettings } from './PromptSettings'

/** Hiding the chat would also hide the way to ask for it back, so this one setting stays a direct switch. */
function OperatorChatVisibility({ value, revision }: { value: AgentDefaults; revision: number }) {
  const save = useUpdateAgentDefaultsMutation()
  const [commandId, setCommandId] = useState(() => crypto.randomUUID())
  return <>
    <Switch label="Show Operator chat" checked={value.operator.uiEnabled} disabled={save.isPending}
      onChange={(event) => save.mutate({ commandId, expectedRevision: revision,
        value: { ...value, operator: { ...value.operator, uiEnabled: event.target.checked } } },
      { onSuccess: () => setCommandId(crypto.randomUUID()) })} />
    {save.isError ? <small className="operator-mcp-error" role="alert">{save.error.message}</small> : null}
  </>
}

/** Role defaults are summary cards; the Operator agent edits them through MCP. */
export function AgentDefaultsSettings({ selectedRole, onOpen }: {
  selectedRole?: SettingsAgentRole; onOpen?(role?: SettingsAgentRole): void;
}) {
  const query = useAgentDefaultsQuery()
  if (selectedRole === 'operator') return <PromptSettings page="operator-initial-prompt" onBack={() => onOpen?.()} />
  if (query.isError) return <ErrorState title="Agent defaults are unavailable" description={query.error.message} onRetry={() => void query.refetch()} />
  if (!query.data) return <LoadingState label="Loading agent defaults…" />
  const { value, revision } = query.data
  return <SettingsOverview title="Agents">
    {agentRoleOrder.map((role) => {
      const info = rolePresentation[role]
      const template = role === 'operator' ? value.operator : agentTemplateForRole(value, role)
      const summary = [...harnessSummary(template.harness),
        { label: 'Native tools', value: nativeToolsSummary(template.nativeTools) }, ...(role === 'master' && !value.master
          ? [{ label: 'Defaults', value: 'Uses Orchestrator settings until configured' }] : []), ...(role === 'operator' ? [
        { label: 'Skills', value: String(value.operator.assignedSkills?.length ?? 0) },
        ...(value.operator.harness.harness === 'codex' ? [{ label: 'Thinking', value: value.operator.showThinking ? 'Shown' : 'Hidden' }] : []),
      ] : [])]
      return <SettingsChoice key={role} title={info.title} summary={summary}
        onSelect={() => {
          if (role === 'operator') onOpen?.(role)
          else askOperator(`Change the ${info.title} defaults: `, { send: false })
        }}
        footer={role === 'operator' ? <OperatorChatVisibility value={value} revision={revision} /> : undefined} />
    })}
  </SettingsOverview>
}
