import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { authService } from '../services';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

/**
 * A wrapper component that protects routes requiring authentication.
 * Shows login prompt for unauthenticated users and access denied for unauthorized users.
 */
export function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { user, isLoading, setUser } = useAuthStore();

  useEffect(() => {
    authService.getCurrentUser().then(setUser);
  }, [setUser]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center max-w-md px-4">
          <h1 className="text-3xl font-bold text-white mb-2">📤 Sendie</h1>
          <p className="text-gray-400 mb-8">Secure P2P File Transfer</p>
          
          <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
            <h2 className="text-xl font-semibold text-white mb-4">Authentication Required</h2>
            <p className="text-gray-400 mb-6">Please sign in with Discord to continue.</p>
            <button
              onClick={() => authService.login(window.location.href)}
              className="w-full px-6 py-3 bg-[#5865F2] hover:bg-[#4752C4] text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
              Sign in with Discord
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!user.isAllowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center max-w-md px-4">
          <div className="bg-red-900/30 rounded-lg p-6 border border-red-500/30">
            <h1 className="text-2xl font-bold text-white mb-4">Access Denied</h1>
            <p className="text-gray-300 mb-2">Your Discord account is not on the allow-list.</p>
            <p className="text-gray-500 text-sm mb-6">Contact an administrator for access.</p>
            
            <div className="flex items-center justify-center gap-3 mb-6 p-3 bg-gray-800 rounded-lg">
              {user.avatarUrl && (
                <img src={user.avatarUrl} alt="" className="w-10 h-10 rounded-full" />
              )}
              <div className="text-left">
                <p className="text-white font-medium">{user.displayName}</p>
                <p className="text-gray-400 text-sm">@{user.username}</p>
              </div>
            </div>
            
            <button
              onClick={() => authService.logout()}
              className="text-gray-400 hover:text-white transition-colors"
            >
              Sign out and try another account
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (requireAdmin && !user.isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center max-w-md px-4">
          <div className="bg-yellow-900/30 rounded-lg p-6 border border-yellow-500/30">
            <h1 className="text-2xl font-bold text-white mb-4">Admin Access Required</h1>
            <p className="text-gray-300">You don't have permission to view this page.</p>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
