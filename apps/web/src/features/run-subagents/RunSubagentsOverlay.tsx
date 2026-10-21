import { useEffect, useRef, useState } from 'react'
import { ViewportPortal } from '@xyflow/react'
import { Button, Icon } from '../../shared/ui/nocturne'
import { layoutSubagents, isTerminalSubagent, SUBAGENT_ORB, type SubagentLayoutNode } from './layout'
import { subagentLabel, subagentName, subagentStatus } from './presentation'
import { useRunSubagents, type SubagentsScope } from './query'
import { useSelectedSubagent } from './selection'
import { SubagentPanel } from './SubagentPanel'
import { useBlockingReadError } from '../../shared/api/readFailure'
import './runSubagents.css'

export function RunSubagentsOverlay({ scope, nodes, visible = true }: {
  scope: SubagentsScope; nodes: readonly SubagentLayoutNode[]; visible?: boolean
}) {
  const query = useRunSubagents(scope, visible)
  const { selected, select } = useSelectedSubagent(scope)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const trigger = useRef<HTMLButtonElement | null>(null)
  const closePanel = () => {
    const orb = trigger.current
    void select(null).then(() => orb?.focus({ preventScroll: true }))
  }
  const blocked = useBlockingReadError(query)
  const children = blocked ? [] : query.data?.pages.flatMap((page) => page.items.map((item) => item.subagent)) ?? []
  const chips = layoutSubagents(nodes, children)
  // Every page loads on its own so all children appear as nodes without a status strip.
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query
  useEffect(() => { if (visible && hasNextPage && !isFetchingNextPage && !isError && !blocked) void fetchNextPage() }, [visible, hasNextPage, isFetchingNextPage, isError, blocked, fetchNextPage])
  return <>
    {visible ? <ViewportPortal>
      <div className="run-subagents-overlay">
        <svg className="run-subagents-links" aria-hidden="true">
          {chips.map(({ subagent, x, y, from }) =>
            <line key={subagent.id} x1={from.x} y1={from.y} x2={x} y2={y} data-live={subagent.status === 'running'} />)}
        </svg>
        {chips.map(({ subagent, x, y, parentId }) => {
          const status = subagentStatus(subagent.status)
          const label = subagentLabel(subagent)
          return <button key={subagent.id} ref={(element) => {
            if (selected === subagent.id && element) trigger.current = element
          }} type="button" className="run-subagent-orb nodrag nopan"
            data-parent-id={parentId} data-subagent-id={subagent.id} data-tone={status.tone}
            data-inactive={isTerminalSubagent(subagent.status)} data-live={subagent.status === 'running'}
            data-uncertain={subagent.evidence !== 'confirmed' || subagent.status === 'unknown'}
            style={{ left: x - SUBAGENT_ORB.labelWidth / 2, top: y - SUBAGENT_ORB.size / 2 }} title={label} aria-label={label} aria-pressed={selected === subagent.id}
            onClick={(event) => { event.stopPropagation(); trigger.current = event.currentTarget; void select(subagent.id) }}>
            <span className="run-subagent-orb-body" aria-hidden="true"><Icon name="bot" size={16} /></span>
            <span className="run-subagent-orb-name" aria-hidden="true">{subagentName(subagent)}</span>
            <span className="run-subagent-orb-status" aria-hidden="true">{status.label}</span>
          </button>
        })}
      </div>
    </ViewportPortal> : null}
    {visible && query.isError && <div className="run-subagents-notice nopan nodrag" role="status">
      <span>Couldn't load subagents.</span><Button size="sm" onClick={() => void query.refetch()}>Retry</Button>
    </div>}
    {!blocked && selected && <SubagentPanel key={`${scope.runId}:${selected}`} scope={scope}
      subagentId={selected} anchor={trigger} onClose={closePanel}
      draft={{ text: drafts[selected] ?? '', onChange: text => setDrafts(current => ({ ...current, [selected]: text })) }}
      visible={visible && chips.some(chip => chip.subagent.id === selected)} />}
  </>
}
