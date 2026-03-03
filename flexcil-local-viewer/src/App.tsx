import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { LibraryProvider } from './context/LibraryContext'
import { DocumentPage } from './pages/DocumentPage'
import { LibraryPage } from './pages/LibraryPage'

function App() {
  return (
    <LibraryProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/doc/:id" element={<DocumentPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </LibraryProvider>
  )
}

export default App
