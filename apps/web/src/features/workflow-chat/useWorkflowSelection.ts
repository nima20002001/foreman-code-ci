import { useQuery } from '@tanstack/react-query'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { isApiAccessError } from '../../shared/api/accessError'
import { workflowChatClient, type WorkflowChatScope } from './client'

/** Receipt links resolve only through the scoped server page, never a node's latest post. */
export function useWorkflowSelection(scope: WorkflowChatScope, selection: { postId?: string; receiptId?: string },
  enabled: boolean, onDenied: () => void) {
  const receipt = useQuery({ queryKey: ['workflow-chat-receipt', identityEpoch(), scope.workspaceId, scope.workflowId, selection.receiptId],
    enabled: enabled && !!selection.receiptId, retry: false,
    queryFn: async ({ signal }) => {
      try { return await workflowChatClient.deliveries(scope, { receiptId: selection.receiptId }, { signal }) }
      catch (error) { if (isApiAccessError(error)) onDenied(); throw error }
    } })
  const selectedReceipt = receipt.data?.items.find(item => item.id === selection.receiptId)
  const postId = selection.postId ?? selectedReceipt?.postId
  const focused = useQuery({ queryKey: ['workflow-chat-post', identityEpoch(), scope.workspaceId, scope.workflowId, postId],
    enabled: enabled && !!postId, retry: false,
    queryFn: async ({ signal }) => {
      try {
        const [posts, receipts] = await Promise.all([workflowChatClient.read(scope, { postId }, { signal }),
          workflowChatClient.deliveries(scope, { postId, limit: 100 }, { signal })])
        return { posts, receipts }
      } catch (error) { if (isApiAccessError(error)) onDenied(); throw error }
    } })
  return { receipt, focused, postId, receiptPostId: selectedReceipt?.postId,
    mismatch: !!selectedReceipt && !!selection.postId && selectedReceipt.postId !== selection.postId }
}
