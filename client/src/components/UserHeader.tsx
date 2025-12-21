import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { authService } from '../services';

/**
 * Header component showing logged-in user info with logout button.
 */
export function UserHeader() {
  const navigate = useNavigate();
  const { user } = useAuthStore();

  if (!user) return null;

  const handleLogout = async () => {
    await authService.logout();
    window.location.reload();
  };

  return (
    <header className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between">
      <div className="flex items-center gap-2">
        {user.isAdmin && (
          <button
            onClick={() => navigate('/admin')}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
          >
            Admin
          </button>
        )}
      </div>
      
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/50 rounded-lg">
          {user.avatarUrl && (
            <img 
              src={user.avatarUrl} 
              alt="" 
              className="w-6 h-6 rounded-full"
            />
          )}
          <span className="text-sm text-gray-300">{user.displayName}</span>
        </div>
        
        <button
          onClick={handleLogout}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
