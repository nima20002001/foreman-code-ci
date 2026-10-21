import type { PropsWithChildren } from 'react'
import { OperatorChatVisibilityContext } from './visibilityContext'

/** HAP-06 supplies its persisted UI flag here; it never controls Operator MCP. */
export function OperatorChatVisibilityProvider({ enabled, children }: PropsWithChildren<{ enabled: boolean }>) {
  return <OperatorChatVisibilityContext value={enabled}>{children}</OperatorChatVisibilityContext>
}
