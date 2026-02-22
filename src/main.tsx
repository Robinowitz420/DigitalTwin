import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './renderer/App'
import './renderer/styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
