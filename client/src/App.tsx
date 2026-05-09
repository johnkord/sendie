import { Routes, Route } from 'react-router-dom'
import HomePage from './pages/HomePage'
import MultiPeerSessionPage from './pages/MultiPeerSessionPage'
import AdminPage from './pages/AdminPage'
import { ProtectedRoute } from './components'

function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 text-slate-100">
      {/* Soft accent glow at the top so the brand feel persists without
          a saturated purple plateau dominating the page. Pointer-events
          off so it never intercepts clicks. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 -z-0 h-[400px] bg-[radial-gradient(ellipse_at_top,_rgba(139,92,246,0.18),transparent_60%)]"
      />
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
