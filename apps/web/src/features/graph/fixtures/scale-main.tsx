import '@fontsource-variable/inter'
import { createRoot } from 'react-dom/client'
import { GraphScaleFixture } from './GraphScaleFixture'
import { initializeTheme } from '../../theme'
import '../../../styles.css'
import '../../../shared/ui/nocturne/legacy-bridge.css'

// Only served by the local Vite dev server; not an application route or a production entry.
if (!import.meta.env.DEV) throw new Error('The synthetic scale fixture is development-only.')
const root = document.getElementById('root')
if (!root) throw new Error('The fixture root element is missing.')
const requested = new URLSearchParams(window.location.search).get('nodes')
const count = requested === '500' ? 500 : 300
initializeTheme()
createRoot(root).render(<GraphScaleFixture count={count} />)
