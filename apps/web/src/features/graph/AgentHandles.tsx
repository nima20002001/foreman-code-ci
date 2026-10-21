import { Handle, Position } from '@xyflow/react'

const hidden = [['top', Position.Top], ['bottom', Position.Bottom], ['left', Position.Left]] as const

/**
 * One visible port on the right rim starts a connection; the whole circle accepts one.
 * The other side ids stay mounted, invisible, so saved connections that name them still resolve.
 */
export function AgentHandles({ name, connectable = true }: { name: string; connectable?: boolean }) {
  return <>
    {hidden.map(([id, position]) => <Handle key={id} id={id} type="source" position={position} isConnectable={false} className="n-agent-side" />)}
    <Handle id="right" type="source" position={Position.Right} isConnectable={connectable} className="n-agent-port"
      aria-label={`Connect ${name} to another agent`} title="Drag this handle to another agent, or click both connection handles" />
    <Handle id="left" type="target" position={Position.Left} isConnectable={connectable} className="n-agent-target"
      aria-label={`Connect to ${name}`} />
  </>
}
