import { asRecord } from '../../shared/records'
import type { PendingNativeInteraction, InteractionResponseValue } from '@foreman-code/contracts'
import { NativeInteractionResponse } from '../../shared/ui/NativeInteractionResponse'
import { Fragment, useId } from 'react'
import { summarizeApprovalRequest } from '../approvals/approvalPresentation'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { Button, Icon } from '../../shared/ui/nocturne'
import './operatorApprovalCard.css'

const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

export function OperatorApprovalCard({ interaction, disabled, onSelect, onBrowse, actor = 'Operator' }: {
  interaction: PendingNativeInteraction
  disabled: boolean
  actor?: 'Operator' | 'Agent'
  onSelect: (optionId: string, response?: InteractionResponseValue) => void
  onBrowse?: () => void
}) {
  const scopeId = useId()
  const request = asRecord(interaction.request)
  const meta = asRecord(request._meta)
  const params = asRecord(meta.tool_params)
  const mcp = interaction.nativeRequestType === 'mcpServer/elicitation/request' && meta.codex_approval_kind === 'mcp_tool_call'
  const summary = summarizeApprovalRequest(interaction.request, interaction.nativeRequestType)
  const tool = string(meta.tool_title) ?? string(meta.tool_name)
  const connector = string(meta.connector_name) ?? string(request.serverName)
  const destination = string(meta.origin) ?? string(params.origin) ?? summary.target
  const options = interaction.responseOptions.filter((option) => !(mcp && option.semantic === 'cancel'
    && option.persistence === 'request' && !option.interruptsCurrentTurn
    && !option.affectsOtherPendingRequests && !option.mutatesPersistentPolicy))
  const once = options.filter((option) => option.semantic === 'approve_once' || option.semantic === 'allow_turn')
  const persistent = options.filter((option) => option.semantic === 'persistent_policy_change')
  const other = options.filter((option) => !once.includes(option) && !persistent.includes(option) && option.semantic !== 'reject')
  const decline = options.filter((option) => option.semantic === 'reject')
  const renderOption = (option: typeof options[number]) => {
    const descriptionId = `${scopeId}-${encodeURIComponent(option.optionId)}`
    const scope = approvalOptionScope(option)
    return <div key={option.optionId} className="operator-approval-choice">
      <Button size="sm"
        variant={option.semantic === 'approve_once' || option.semantic === 'allow_turn' ? 'primary' : option.semantic === 'reject' ? 'ghost' : 'secondary'}
        disabled={disabled} onClick={() => onSelect(option.optionId)} aria-describedby={descriptionId}
        title={scope}>{mcp && option.semantic === 'approve_once' ? 'Allow once' : option.label}</Button>
      <p id={descriptionId} className="operator-approval-scope">
        {string(option.scopeSummary) ? <span>{option.scopeSummary} </span> : null}{scope}
      </p>
    </div>
  }
  return <section className="operator-approval-card" aria-label={`${actor} approval request`}>
    <div className="operator-approval-heading"><span className="operator-approval-mark"><Icon name="lock" size={15} /></span><div>
      <h3>{mcp && tool ? `${tool}?` : summary.operation}</h3>
      <p>{mcp ? `MCP tool · ${connector ?? 'Provider'}` : interaction.nativeRequestType === 'item/commandExecution/requestApproval' ? 'Shell command' : interaction.nativeRequestType === 'item/fileChange/requestApproval' ? 'File change' : `${actor} request`}</p>
    </div></div>
    {destination ? <p className="operator-approval-target">{mcp ? 'Access' : 'Target'} <strong>{destination}</strong></p> : null}
    {summary.command ? <code className="operator-approval-command">{summary.command}</code> : null}
    {summary.explanation ? <p className="operator-approval-reason">{summary.explanation}</p> : null}
    <details className="operator-approval-disclosure"><summary onClick={(event) => {
      // Pause following before the disclosure changes height (also covers the
      // click synthesized by keyboard activation and touch).
      if (!event.currentTarget.closest('details')?.open) onBrowse?.()
    }}><Icon name="info" size={14} /> Request details</summary>
      <dl>
        <dt>Execution</dt><dd>{mcp ? 'MCP tool call through the connected provider' : interaction.nativeRequestType === 'item/commandExecution/requestApproval' ? 'Shell command requested by the agent' : interaction.nativeRequestType === 'item/fileChange/requestApproval' ? 'File change requested by the agent' : interaction.nativeRequestType}</dd>
        {string(meta.tool_name) ? <><dt>Tool</dt><dd>{string(meta.tool_name)}</dd></> : null}
        {connector ? <><dt>Provider</dt><dd>{connector}</dd></> : null}
        {Object.keys(params).map((key) => <Fragment key={key}><dt>{key}</dt><dd>{typeof params[key] === 'string' ? String(params[key]) : JSON.stringify(params[key])}</dd></Fragment>)}
      </dl>
      <p>Full request</p>
      <pre className="operator-approval-request" tabIndex={0} aria-label="Full approval request">{JSON.stringify(interaction.request, null, 2)}</pre>
    </details>
    {options.some((option) => option.input) ? <NativeInteractionResponse
      key={interaction.turn.nativeRequestId} options={options} disabled={disabled} onSelect={onSelect} /> : <>
      <div className="operator-approval-actions">{[...once, ...persistent, ...other].map(renderOption)}</div>
      {decline.length ? <div className="operator-approval-decline">{decline.map(renderOption)}</div> : null}
    </>}
  </section>
}
