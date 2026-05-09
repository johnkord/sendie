import { useState, useCallback } from 'react';

interface SessionLinkProps {
  sessionId: string;
  // The 128-bit join secret returned by POST /api/sessions, base64url-encoded.
  // Carried in the URL fragment (#k=...) so it never reaches the server in
  // the initial GET. Required: a session URL without the secret cannot join.
  sessionSecret: string;
}

export function SessionLink({ sessionId, sessionSecret }: SessionLinkProps) {
  const [copied, setCopied] = useState(false);

  // The secret rides in the URL fragment so:
  //   1. Browsers do not send fragments in the HTTP request line.
  //   2. Server access logs and proxy logs never see the secret.
  //   3. URL-preview bots (Discord, Slack, etc.) that fetch the link see
  //      only the public ID, not the secret, so they cannot enumerate
  //      session contents.
  const shareUrl = `${window.location.origin}/s/${sessionId}#k=${sessionSecret}`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [shareUrl]);

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
      <p className="text-sm text-gray-400 mb-2">
        Share this link with someone to start transferring files:
      </p>
      
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={shareUrl}
          readOnly
          className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm font-mono"
          onClick={(e) => e.currentTarget.select()}
        />
        
        <button
          onClick={handleCopy}
          className={`
            px-4 py-2 rounded-lg font-medium transition-all
            ${copied 
              ? 'bg-green-600 text-white' 
              : 'bg-purple-600 hover:bg-purple-700 text-white'
            }
          `}
          title="Copy session link to clipboard"
        >
          {copied ? '✓ Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
