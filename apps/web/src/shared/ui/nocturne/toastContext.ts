import { createContext } from 'react'
import type { Tone } from './utils'
export interface ToastInput { title: string; description?: string; tone?: Tone; action?: { label: string; onClick: () => void } }
export interface ToastContextValue { notify: (toast: ToastInput) => string; dismiss: (id: string) => void }
export const ToastContext = createContext<ToastContextValue | null>(null)
