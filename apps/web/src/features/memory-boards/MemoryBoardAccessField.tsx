import { Select } from '../../shared/ui/nocturne/Fields'
import { memoryAccess, memoryToolNames, replaceMemoryAccess, type MemoryAccess } from './access'

export interface MemoryBoardAccessFieldProps {
  value: readonly string[] | undefined
  agentDefaultTools: readonly string[]
  readOnly: boolean
  disabled?: boolean
  onChange(tools: string[] | undefined): void
}
/** This field edits the existing tool array; D owns save/default/pinned-run semantics. */
export function MemoryBoardAccessField({ value, agentDefaultTools, readOnly, disabled, onChange }: MemoryBoardAccessFieldProps) {
  const effective = value ?? agentDefaultTools
  const access = memoryAccess(effective)
  return <div className="n-stack">
    <Select label="Memory access" value={value === undefined ? 'inherit' : access} disabled={disabled}
      options={[
        { value: 'inherit', label: `Use agent default (${memoryAccess(agentDefaultTools)})` },
        { value: 'none', label: 'None' }, { value: 'read', label: 'Read' }, { value: 'write', label: 'Write' },
        ...(access === 'custom' ? [{ value: 'custom', label: 'Custom', disabled: true }] : []),
      ]}
      onChange={(event) => {
        const next = event.currentTarget.value
        if (next === 'inherit') {
          const other = effective.filter((tool) => !memoryToolNames.includes(tool))
          const inheritedOther = agentDefaultTools.filter((tool) => !memoryToolNames.includes(tool))
          const canInheritAll = other.length === inheritedOther.length && other.every((tool) => inheritedOther.includes(tool))
          onChange(canInheritAll ? undefined : [...other, ...agentDefaultTools.filter((tool) => memoryToolNames.includes(tool))])
        }
        else if (next !== 'custom') onChange(replaceMemoryAccess(effective, next as Exclude<MemoryAccess, 'custom'>))
      }}
      hint="Applies to the next run. Apply to draft, then Save workflow." />
    <p className="n-field-hint">Effective memory access: {readOnly && (access === 'write' || access === 'custom') ? 'Read-only restrictions apply' : access}.</p>
    {readOnly && <p>Read-only agent: board changes are unavailable.</p>}
    {value !== undefined && <p className="n-field-hint">Choosing the agent default keeps other tool overrides and copies its current memory choice when full inheritance would change them.</p>}
    {access === 'custom' && <p className="n-field-hint">Enabled memory tools: {effective.filter((tool) => memoryToolNames.includes(tool)).join(', ') || 'None'}.</p>}
  </div>
}
