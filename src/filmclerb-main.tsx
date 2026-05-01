import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import FilmClerbApp from './FilmClerbApp.tsx'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')
createRoot(root).render(
  <StrictMode>
    <FilmClerbApp />
  </StrictMode>,
)
