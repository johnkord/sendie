import { useState, useCallback } from 'react';

interface SessionLinkProps {
  sessionId: string;
}

export function SessionLink({ sessionId }: SessionLinkProps) {
  const [copied, setCopied] = useState(false);
  
  const shareUrl = `${window.location.origin}/s/${sessionId}`;

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
