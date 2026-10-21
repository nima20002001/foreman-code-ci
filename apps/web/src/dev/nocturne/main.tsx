import '@fontsource-variable/inter'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '../../shared/ui/nocturne'
import { ToolkitShowcase } from './ToolkitShowcase'
import '../../shared/ui/nocturne/nocturne.css'
import './showcase.css'

const root = document.getElementById('root')
if (!root) throw new Error('The Nocturne preview root is missing.')
createRoot(root).render(<StrictMode><ToastProvider><ToolkitShowcase /></ToastProvider></StrictMode>)
