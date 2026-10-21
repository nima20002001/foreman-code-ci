import { useMemo, useState } from 'react'
import type { CiRunJob } from '@foreman-code/contracts'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { CiServerDialog } from './CiServer'
import { ciServerFlowNode, ciServerSummary } from './ciServer'

/** The draft and saved-Run Boards show the same presentation-only CI server as live inspection.
 * Without a Run scope it is idle; with one, its jobs come from the caller's CI read. */
export function useBoardCiServer({ nodes, names, workflow, scope, jobs, truncated = false, error = false, loading = false }: {
  nodes: Parameters<typeof ciServerFlowNode>[0]; names: ReadonlyMap<string, string>
  workflow: { workspaceId: string; workflowId: string }; scope?: RepeatGraphScopeV3; jobs?: readonly CiRunJob[] | undefined
  truncated?: boolean; error?: boolean; loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => !scope || jobs ? ciServerSummary(jobs ?? []) : {
    ...ciServerSummary([]), state: 'unavailable' as const, label: error ? 'CI unavailable' : 'Loading CI',
  }, [scope, jobs, error])
  const node = useMemo(() => ciServerFlowNode(nodes, summary, () => setOpen(true)), [nodes, summary])
  const dialog = <CiServerDialog open={open} onOpenChange={setOpen} scope={scope} workflow={workflow} jobs={jobs ?? []} names={names}
    truncated={truncated} error={error} loading={loading} />
  return { node, dialog }
}
