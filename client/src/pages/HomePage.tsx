import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Session } from '../types';
import { UserHeader, Footer } from '../components';

/**
 * Parse rate limit error from response or error message.
 * Returns retry time in seconds if rate limited, null otherwise.
 */
function parseRateLimitError(response?: Response, error?: Error): { retryAfter: number } | null {
  // Check for HTTP 429
  if (response?.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    return { retryAfter: retryAfter ? parseInt(retryAfter, 10) : 60 };
  }
  
  // Check for SignalR rate limit message
  if (error?.message?.includes('Rate limit exceeded')) {
    const match = error.message.match(/(\d+)\s*seconds?/);
    return { retryAfter: match ? parseInt(match[1], 10) : 60 };
  }
  
  return null;
}

export default function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [joinSessionId, setJoinSessionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rateLimitRetry, setRateLimitRetry] = useState<number | null>(null);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [kickedMessage, setKickedMessage] = useState<string | null>(null);

  // Check if user was kicked from a session
  useEffect(() => {
    if (location.state?.kicked) {
      setKickedMessage('You have been removed from the session by the host.');
      // Clear the state so the message doesn't persist on refresh
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  const handleCreateSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRateLimitRetry(null);

    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
      });

      const rateLimit = parseRateLimitError(response);
      if (rateLimit) {
        setRateLimitRetry(rateLimit.retryAfter);
        setError(`You're creating sessions too quickly.`);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to create session');
      }

      const session: Session = await response.json();
      navigate(`/s/${session.id}`);
    } catch (err) {
      const rateLimit = parseRateLimitError(undefined, err instanceof Error ? err : undefined);
      if (rateLimit) {
        setRateLimitRetry(rateLimit.retryAfter);
        setError(`You're creating sessions too quickly.`);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create session');
      }
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  const handleJoinSession = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!joinSessionId.trim()) {
      setError('Please enter a session ID');
      return;
    }

    // Extract session ID from URL or use as-is
    let sessionId = joinSessionId.trim();
    
    // Handle full URL input
    if (sessionId.includes('/s/')) {
      const match = sessionId.match(/\/s\/([a-z0-9]+)/i);
      if (match) {
        sessionId = match[1];
      }
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/sessions/${sessionId}`);
      
      if (!response.ok) {
        throw new Error('Session not found');
      }

      navigate(`/s/${sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Session not found');
      setLoading(false);
    }
  }, [joinSessionId, navigate]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 relative">
      <UserHeader />
      
      <div className="max-w-md w-full">
        {/* Kicked Message */}
        {kickedMessage && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-600/50 rounded-lg">
            <div className="flex items-center gap-2">
              <span>🚫</span>
              <p className="text-red-300">{kickedMessage}</p>
            </div>
            <button
              onClick={() => setKickedMessage(null)}
              className="mt-2 text-sm text-red-400 hover:text-red-300"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Logo and Title */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold text-white mb-2">
            📤 Sendie
          </h1>
          <p className="text-xl text-gray-300">
            Secure P2P File Transfer
          </p>
          <p className="text-gray-500 mt-2">
            Share files directly between browsers. No upload limits. End-to-end encrypted.
          </p>
        </div>

        {/* Create Session Button */}
        <button
          onClick={handleCreateSession}
          disabled={loading}
          className={`
            w-full py-4 px-6 rounded-xl font-semibold text-lg
            transition-all duration-200
            ${loading 
              ? 'bg-gray-600 cursor-not-allowed' 
              : 'bg-purple-600 hover:bg-purple-700 hover:scale-[1.02] active:scale-[0.98]'
            }
            text-white shadow-lg shadow-purple-500/25
          `}
        >
          {loading ? 'Creating...' : 'Create New Session'}
        </button>

        {/* Divider */}
        <div className="flex items-center gap-4 my-6">
          <div className="flex-1 h-px bg-gray-700" />
          <span className="text-gray-500 text-sm">or</span>
          <div className="flex-1 h-px bg-gray-700" />
        </div>

        {/* Join Session Form */}
        <form onSubmit={handleJoinSession} className="space-y-3">
          <input
            type="text"
            value={joinSessionId}
            onChange={(e) => setJoinSessionId(e.target.value)}
            placeholder="Enter session ID or paste link"
            disabled={loading}
            className={`
              w-full px-4 py-3 rounded-xl
              bg-gray-800 border border-gray-700
              text-white placeholder-gray-500
              focus:outline-none focus:border-purple-500
              transition-colors
              ${loading ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          />
          
          <button
            type="submit"
            disabled={loading || !joinSessionId.trim()}
            className={`
              w-full py-3 px-6 rounded-xl font-medium
              transition-all duration-200
              ${loading || !joinSessionId.trim()
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-gray-700 hover:bg-gray-600 text-white'
              }
            `}
          >
            Join Session
          </button>
        </form>

        {/* Error Message */}
        {error && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <div className="flex items-start gap-3">
              <span className="text-red-400 text-xl">{rateLimitRetry ? '⏱️' : '⚠️'}</span>
              <div>
                <p className="text-red-400 font-medium">{error}</p>
                {rateLimitRetry && (
                  <p className="text-red-400/70 text-sm mt-1">
                    Please wait {rateLimitRetry < 60 
                      ? `${rateLimitRetry} seconds` 
                      : rateLimitRetry < 3600
                        ? `${Math.ceil(rateLimitRetry / 60)} minutes`
                        : `${Math.ceil(rateLimitRetry / 3600)} hour${Math.ceil(rateLimitRetry / 3600) > 1 ? 's' : ''}`
                    } before trying again.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Features */}
        <div className="mt-12 grid grid-cols-3 gap-4 text-center">
          <div className="p-3">
            <div className="text-2xl mb-1">🔒</div>
            <p className="text-xs text-gray-400">End-to-End Encrypted</p>
          </div>
          <div className="p-3">
            <div className="text-2xl mb-1">🚀</div>
            <p className="text-xs text-gray-400">No Size Limits</p>
          </div>
          <div className="p-3">
            <div className="text-2xl mb-1">�</div>
            <p className="text-xs text-gray-400">Up to 10 Peers</p>
          </div>
        </div>

        {/* How it works toggle */}
        <div className="mt-8">
          <button
            onClick={() => setShowHowItWorks(!showHowItWorks)}
            className="w-full text-center text-gray-500 hover:text-gray-300 text-sm transition-colors flex items-center justify-center gap-1"
          >
            How does it work?
            <span className={`transition-transform ${showHowItWorks ? 'rotate-180' : ''}`}>▼</span>
          </button>
          
          {showHowItWorks && (
            <div className="mt-4 p-4 bg-gray-800/50 rounded-xl border border-gray-700 text-sm text-gray-300 space-y-3">
              <p>
                <strong className="text-white">Files never touch our servers.</strong> When you create a session and share the link, 
                Sendie establishes direct peer-to-peer connections between browsers using WebRTC.
              </p>
              <p>
                <strong className="text-white">Everything is encrypted.</strong> WebRTC uses DTLS encryption automatically—we couldn't 
                see your files even if we wanted to.
              </p>
              <p>
                <strong className="text-white">Verify who you're talking to.</strong> Each connection shows a verification code (SAS). 
                Compare it with your recipient to confirm there's no one in the middle.
              </p>
              <p className="text-gray-500 text-xs pt-2 border-t border-gray-700">
                We only know that a session existed, not what was transferred. Your Discord username is used for session creation only.
              </p>
            </div>
          )}
        </div>

        <Footer />
      </div>
    </div>
  );
}
