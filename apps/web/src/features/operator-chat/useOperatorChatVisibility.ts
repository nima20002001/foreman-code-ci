import { useContext } from 'react'

import { OperatorChatVisibilityContext } from './visibilityContext'

export function useOperatorChatVisibility() { return useContext(OperatorChatVisibilityContext) }
