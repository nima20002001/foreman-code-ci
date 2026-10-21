import type { MemoryCardWorkSelection } from '@foreman-code/contracts'
import { Checkbox } from '../../shared/ui/nocturne/Fields'
import { Button } from '../../shared/ui/nocturne/Button'
import type { MemoryNodeOption } from './ports'
import { nodeKey, nodeLabel } from './presentation'
import { selectionKey } from './cardEditing'
import type { CardDraft } from './drafts'

export function MemoryWorkPicker({ draft, nodes, disabled, onChange }: {
  draft: CardDraft; nodes: readonly MemoryNodeOption[]; disabled: boolean; onChange(draft: CardDraft): void
}) {
  const toggle = (selection: MemoryCardWorkSelection, checked: boolean) => {
    const rest = draft.workSelections.filter((item) => selectionKey(item) !== selectionKey(selection))
    onChange({ ...draft, dirty: true, workSelections: checked ? [...rest, selection] : rest })
  }
  const linked = new Set(draft.fields.linkedNodes.map(nodeKey))
  return <fieldset className="memory-fieldset" disabled={disabled}>
    <legend>Linked nodes and work</legend>
    <p className="n-field-hint">Owner and node links do not start agents. Choose exact work to track its completion.</p>
    {!nodes.length && <p>No saved nodes are available in this scope.</p>}
    {nodes.map((option) => {
      const id = nodeKey(option.node)
      const next: MemoryCardWorkSelection = { kind: 'next_activation', node: option.node }
      const selected = (selection: MemoryCardWorkSelection) => draft.workSelections.some((item) => selectionKey(item) === selectionKey(selection))
      return <div className="memory-work-option" key={id}>
        <Checkbox label={option.label} checked={linked.has(id)} disabled={!option.available || !linked.has(id) && !option.currentWork.length && draft.workSelections.length >= 32}
          onChange={(event) => {
            const checked = event.currentTarget.checked
            const linkedNodes = draft.fields.linkedNodes.filter((node) => nodeKey(node) !== id)
            const workSelections = checked && !option.currentWork.length && !selected(next) ? [...draft.workSelections, next] : draft.workSelections
            onChange({ ...draft, dirty: true, fields: { ...draft.fields, linkedNodes: checked ? [...linkedNodes, option.node] : linkedNodes }, workSelections })
          }} />
        {linked.has(id) && <div className="memory-work-choices">
          <Checkbox label={`Next activation · ${option.label}`} checked={selected(next)} disabled={!option.available || draft.workSelections.length >= 32 && !selected(next)}
            onChange={(event) => toggle(next, event.currentTarget.checked)} />
          {option.currentWork.map((current) => {
            const selection: MemoryCardWorkSelection = { kind: 'current', work: current.work }
            return <Checkbox key={selectionKey(selection)} label={`Current work · ${current.label}`} checked={selected(selection)}
              disabled={!option.available || draft.workSelections.length >= 32 && !selected(selection)}
              onChange={(event) => toggle(selection, event.currentTarget.checked)} />
          })}
        </div>}
      </div>
    })}
    {draft.workSelections.length > 0 && <div><p>{draft.workSelections.length} new work obligation{draft.workSelections.length === 1 ? '' : 's'} selected.</p>
      <ul>{draft.workSelections.map((selection) => <li key={selectionKey(selection)}>
        {selection.kind === 'next_activation' ? `Next activation · ${nodeLabel(selection.node, nodes)}` : `Current work · Run ${selection.work.runId.slice(0, 8)}`}
        <Button size="sm" onClick={() => toggle(selection, false)}>Remove work selection</Button>
      </li>)}</ul><p className="n-field-hint">Removing a display link does not remove a selected work obligation. Remove it here before saving if it is no longer intended.</p>
    </div>}
  </fieldset>
}
