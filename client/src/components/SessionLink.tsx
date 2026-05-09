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
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
        Invite link
      </p>
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          value={shareUrl}
          readOnly
          className="flex-1 min-w-0 bg-slate-950/60 border border-slate-700 rounded-md px-3 py-1.5 text-slate-200 text-xs font-mono focus:outline-none focus:border-purple-500"
          onClick={(e) => e.currentTarget.select()}
          title="Click to select, then copy"
        />
        <button
          onClick={handleCopy}
          className={`
            shrink-0 px-3 py-1.5 rounded-md text-sm font-medium transition-all
            ${copied
              ? 'bg-emerald-600 text-white'
              : 'bg-purple-600 hover:bg-purple-700 text-white'
            }
          `}
          title="Copy session link to clipboard"
        >
          {copied ? '✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
