import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { Button, Icon, type ButtonProps } from '../../shared/ui/nocturne'
import { NewWorkflowDialog } from './NewWorkflowDialog'

export function NewWorkflowAction({ workspaceId, navigation = false, variant = 'primary', size = 'md' }: {
  workspaceId: string
  navigation?: boolean
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
}) {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  return <>
    <Button
      className={navigation ? 'workflow-navigation-add' : undefined}
      variant={navigation ? 'secondary' : variant}
      size={navigation ? 'sm' : size}
      title="New workflow"
      aria-label="New workflow"
      aria-haspopup="dialog"
      aria-expanded={creating}
      leading={<Icon name="plus" size={15} />}
      onClick={() => setCreating(true)}
    >
      {navigation ? <span className="nav-item-label">New workflow</span> : 'New workflow'}
    </Button>
    {creating ? <NewWorkflowDialog
      workspaceId={workspaceId}
      onCancel={() => setCreating(false)}
      onCreated={(workflowId) => {
        setCreating(false)
        void navigate({
          to: '/workspaces/$workspaceId',
          params: { workspaceId },
          // A new workflow starts clean: no agent or Run selection from the previous board.
          search: { workflowId },
        })
      }}
    /> : null}
  </>
}
