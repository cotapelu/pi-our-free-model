import { createRoot } from 'react-dom/client'
import { createElement as h } from 'react'
import { Shell } from './pages/Shell'
import { api, setApiBase } from './api'

// Set the API base URL
setApiBase('/api/management')

// Get locale from document
const locale = document.documentElement.lang || 'en'

// Create root and render
const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element not found')
}

const root = createRoot(container)
root.render(h(Shell, { t: (key) => key, locale }))