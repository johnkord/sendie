import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '../services';
import type { AllowedUser } from '../services';

export default function AdminPage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<AllowedUser[]>([]);
  const [admins, setAdmins] = useState<string[]>([]);
  const [newUserId, setNewUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    try {
      const data = await authService.getAllowedUsers();
      setUsers(data.users);
      setAdmins(data.admins);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const addUser = async () => {
    const trimmedId = newUserId.trim();
    if (!trimmedId) return;
    
    // Validate format
    if (!/^\d{17,19}$/.test(trimmedId)) {
      setError('Invalid Discord user ID format. Must be 17-19 digits.');
      return;
    }
    
    try {
      await authService.addUser(trimmedId);
      setNewUserId('');
      setSuccess(`User ${trimmedId} added to allow-list`);
      setError(null);
      fetchUsers();
      
      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add user');
      setSuccess(null);
    }
  };

  const removeUser = async (discordUserId: string) => {
    if (!confirm(`Are you sure you want to remove user ${discordUserId}?`)) {
      return;
    }
    
    try {
      await authService.removeUser(discordUserId);
      setSuccess(`User ${discordUserId} removed from allow-list`);
      setError(null);
      fetchUsers();
      
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user');
      setSuccess(null);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      addUser();
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white">Admin Panel</h1>
            <p className="text-gray-400 mt-1">Manage allowed users</p>
          </div>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
          >
            ← Back to App
          </button>
        </div>
        
        {/* Messages */}
        {error && (
          <div className="bg-red-900/50 text-red-200 p-4 rounded-lg mb-6 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-300 hover:text-white">
              ✕
            </button>
          </div>
        )}
        
        {success && (
          <div className="bg-green-900/50 text-green-200 p-4 rounded-lg mb-6 flex items-center justify-between">
            <span>{success}</span>
            <button onClick={() => setSuccess(null)} className="text-green-300 hover:text-white">
              ✕
            </button>
          </div>
        )}
        
        {/* Add User Form */}
        <div className="bg-gray-800/50 rounded-lg p-6 mb-8 border border-gray-700">
          <h2 className="text-xl font-semibold text-white mb-4">Add User</h2>
          <div className="flex gap-4">
            <input
              type="text"
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Discord User ID (e.g., 123456789012345678)"
              className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none placeholder-gray-500"
            />
            <button
              onClick={addUser}
              disabled={!newUserId.trim()}
              className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
            >
              Add User
            </button>
          </div>
          <p className="text-gray-500 text-sm mt-2">
            To find a Discord user ID: Enable Developer Mode in Discord settings, then right-click a user and select "Copy User ID"
          </p>
        </div>
        
        {/* Admins List */}
        <div className="bg-gray-800/50 rounded-lg p-6 mb-8 border border-gray-700">
          <h2 className="text-xl font-semibold text-white mb-4">
            Administrators
            <span className="text-gray-500 text-sm font-normal ml-2">(defined in config)</span>
          </h2>
          {admins.length === 0 ? (
            <p className="text-gray-400">No admins configured</p>
          ) : (
            <ul className="space-y-2">
              {admins.map((adminId) => (
                <li key={adminId} className="flex items-center gap-3 text-gray-300 bg-gray-700/50 px-4 py-3 rounded-lg">
                  <span className="text-yellow-400">👑</span>
                  <code className="font-mono">{adminId}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
        
        {/* Users List */}
        <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
          <h2 className="text-xl font-semibold text-white mb-4">
            Allowed Users
            <span className="text-gray-500 text-sm font-normal ml-2">({users.length} total)</span>
          </h2>
          
          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mx-auto"></div>
              <p className="text-gray-400 mt-2">Loading...</p>
            </div>
          ) : users.length === 0 ? (
            <p className="text-gray-400 text-center py-8">No users on the allow-list</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="pb-3 font-medium">Discord ID</th>
                    <th className="pb-3 font-medium">Added At</th>
                    <th className="pb-3 font-medium">Added By</th>
                    <th className="pb-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.discordUserId} className="border-b border-gray-700/50">
                      <td className="py-4">
                        <code className="font-mono text-gray-300">{user.discordUserId}</code>
                        {admins.includes(user.discordUserId) && (
                          <span className="ml-2 text-yellow-400" title="Administrator">👑</span>
                        )}
                      </td>
                      <td className="py-4 text-gray-400">
                        {new Date(user.addedAt).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </td>
                      <td className="py-4 text-gray-400">
                        {user.addedByAdminId === 'config' ? (
                          <span className="text-gray-500 italic">config</span>
                        ) : (
                          <code className="font-mono text-sm">{user.addedByAdminId}</code>
                        )}
                      </td>
                      <td className="py-4 text-right">
                        {!admins.includes(user.discordUserId) && (
                          <button
                            onClick={() => removeUser(user.discordUserId)}
                            className="text-red-400 hover:text-red-300 transition-colors px-3 py-1 rounded hover:bg-red-900/30"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
