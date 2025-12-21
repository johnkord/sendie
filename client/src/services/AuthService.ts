export interface User {
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  isAllowed: boolean;
}

export interface AllowedUser {
  discordUserId: string;
  addedAt: string;
  addedByAdminId: string;
}

export interface AdminUsersResponse {
  admins: string[];
  users: AllowedUser[];
}

class AuthService {
  /**
   * Get the currently authenticated user's information.
   * Returns null if not authenticated.
   */
  async getCurrentUser(): Promise<User | null> {
    try {
      const response = await fetch('/api/auth/me');
      if (response.status === 401) return null;
      if (!response.ok) throw new Error('Failed to get user');
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Redirect to Discord OAuth login.
   */
  login(returnUrl?: string): void {
    const url = returnUrl 
      ? `/api/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`
      : '/api/auth/login';
    window.location.href = url;
  }

  /**
   * Log out the current user.
   */
  async logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  /**
   * Get all allowed users (admin only).
   */
  async getAllowedUsers(): Promise<AdminUsersResponse> {
    const response = await fetch('/api/admin/users');
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch users');
    }
    return await response.json();
  }

  /**
   * Add a user to the allow-list (admin only).
   */
  async addUser(discordUserId: string): Promise<void> {
    const response = await fetch(`/api/admin/users/${discordUserId}`, {
      method: 'POST',
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to add user');
    }
  }

  /**
   * Remove a user from the allow-list (admin only).
   */
  async removeUser(discordUserId: string): Promise<void> {
    const response = await fetch(`/api/admin/users/${discordUserId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to remove user');
    }
  }
}

export const authService = new AuthService();
