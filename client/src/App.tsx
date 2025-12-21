import { Routes, Route } from 'react-router-dom'
import HomePage from './pages/HomePage'
import MultiPeerSessionPage from './pages/MultiPeerSessionPage'
import AdminPage from './pages/AdminPage'
import { ProtectedRoute } from './components'

function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900">
      <Routes>
        <Route 
          path="/" 
          element={
            <ProtectedRoute>
              <HomePage />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/s/:sessionId" 
          element={<MultiPeerSessionPage />} 
        />
        <Route 
          path="/admin" 
          element={
            <ProtectedRoute requireAdmin>
              <AdminPage />
            </ProtectedRoute>
          } 
        />
      </Routes>
    </div>
  )
}

export default App
