import { createRoot } from 'react-dom/client'
import './index.css'
import 'pdfjs-dist/legacy/web/pdf_viewer.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <App />,
)
