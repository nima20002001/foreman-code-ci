import type { OperatorActivity } from '@foreman-code/contracts'
import { Icon } from '../../shared/ui/nocturne'
import { OperatorThinking } from './OperatorThinking'

const labels: Record<OperatorActivity['kind'], string> = {
  thinking: 'Thinking', tool: 'Tool', mcp: 'MCP', web_search: 'Web', file_read: 'Read', file_write: 'Write', subagent: 'Subagent',
}
const statuses: Record<OperatorActivity['status'], string> = {
  pending: 'Waiting', running: 'Running', completed: '', failed: 'Failed', canceled: 'Stopped', unknown: 'Status unavailable',
}

export function OperatorActivityList({ entries, activeRequestId, parts, onBrowse }: {
  entries: readonly OperatorActivity[]; activeRequestId?: string | null; parts?: Record<string, string>; onBrowse(): void;
}) {
  if (!entries.length) return null
  return <div className="operator-activity-list" aria-label="Agent activity">
    {entries.map((entry) => {
      if (entry.kind === 'thinking') {
        const live = entry.requestId === activeRequestId ? parts?.[`thinking:${entry.id}`] : undefined
        const text = entry.status === 'completed' ? entry.output || live : live || entry.output
        if (!text) return null
        return <OperatorThinking key={`${entry.requestId}:${entry.id}`} text={text} onBrowse={onBrowse} />
      }
      if (entry.kind === 'mcp') {
        if (entry.status === 'completed') return null
        return <div key={`${entry.requestId}:${entry.id}`} className="operator-mcp-activity" role="status">
          MCP tool call{statuses[entry.status] ? ` · ${statuses[entry.status]}` : ''}
        </div>
      }
      return <div key={`${entry.requestId}:${entry.id}`} className="operator-tool-activity" data-activity-kind={entry.kind}
        onClickCapture={(event) => { if ((event.target as HTMLElement).closest('summary')) onBrowse() }}>
        <details className="operator-activity-disclosure">
          <summary><span>{`${labels[entry.kind]} · ${entry.title}`}</span><Icon name="chevron" size={10} />{entry.status !== 'completed' ? <small>{statuses[entry.status]}</small> : null}</summary>
          <div className="operator-activity-details">
          {entry.input ? <div><strong>Input</strong><pre>{entry.input}</pre></div> : null}
          {entry.output ? <div><strong>Output</strong><pre>{entry.output}</pre></div> : null}
          {!entry.input && !entry.output ? <p>Details are not included in this view.</p> : null}
          {entry.truncated ? <p className="operator-activity-note">Long details have been shortened.</p> : null}
          </div>
        </details>
      </div>
    })}
  </div>
}
