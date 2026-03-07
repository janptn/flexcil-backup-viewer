import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { LibraryProvider } from './context/LibraryContext'
import { DocumentPage } from './pages/DocumentPage'
import { LibraryPage } from './pages/LibraryPage'
import { WorkspacePage } from './pages/WorkspacePage'

function App() {
  return (
    <LibraryProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/doc/:id" element={<DocumentPage />} />
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </LibraryProvider>
  )
}

export default App
