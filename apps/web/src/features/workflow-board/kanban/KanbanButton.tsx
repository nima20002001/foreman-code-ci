import { Button, Icon } from '../../../shared/ui/nocturne'
import { errorMessage } from '../../memory-boards/presentation'
import { useKanbanLayout } from './kanbanLayout'

/** Puts the workflow's memory board on the Board canvas as the Kanban object, or takes it off again. */
export function KanbanButton({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const { layout, save, saveError } = useKanbanLayout(workspaceId, workflowId)
  const shown = layout?.visible === true
  return <Button size="sm" variant="ghost" leading={<Icon name="grid" size={14} />} aria-pressed={shown} disabled={!layout}
    title={saveError ? `Kanban layout not saved: ${errorMessage(saveError)}` : shown ? 'Remove the Kanban from the Board' : 'Add the Kanban to the Board'}
    onClick={() => { if (layout) save({ ...layout, visible: !shown }) }}>Kanban</Button>
}
