import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import FilmClerbAppV2 from './FilmClerbAppV2.tsx'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')
createRoot(root).render(
  <StrictMode>
    <FilmClerbAppV2 />
  </StrictMode>,
)
