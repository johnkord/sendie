import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionLink } from './SessionLink';

describe('SessionLink', () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    Object.assign(navigator, {
      clipboard: originalClipboard,
    });
  });

  it('should render session link input', () => {
    render(<SessionLink sessionId="abc123" sessionSecret="secret456" />);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toContain('/s/abc123');
  });

  it('should render copy button', () => {
    render(<SessionLink sessionId="abc123" sessionSecret="secret456" />);
    
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('should copy link to clipboard when copy button clicked', async () => {
    render(<SessionLink sessionId="abc123" sessionSecret="secret456" />);
    
    const copyButton = screen.getByText('Copy');
    fireEvent.click(copyButton);
    
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('/s/abc123')
      );
    });
  });

  it('should show copied confirmation after clicking', async () => {
    render(<SessionLink sessionId="abc123" sessionSecret="secret456" />);
    
    const copyButton = screen.getByText('Copy');
    fireEvent.click(copyButton);
    
    await waitFor(() => {
      expect(screen.getByText('✓')).toBeInTheDocument();
    });
  });

  it('should display invite link header', () => {
    render(<SessionLink sessionId="abc123" sessionSecret="secret456" />);

    expect(screen.getByText(/Invite link/i)).toBeInTheDocument();
  });

  it('should have read-only input', () => {
    render(<SessionLink sessionId="abc123" sessionSecret="secret456" />);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
  });

  it('should embed the session secret in the URL fragment', () => {
    // Phase 6.1 (audit C4): the secret rides in #k=... so it never reaches
    // the server in the initial GET. The path-only URL is meaningless.
    render(<SessionLink sessionId="xyz789" sessionSecret="top-secret-key" />);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toMatch(/^http.*\/s\/xyz789#k=top-secret-key$/);
    // Sanity: the secret must NOT appear in the path.
    const url = new URL(input.value);
    expect(url.pathname).toBe('/s/xyz789');
    expect(url.hash).toBe('#k=top-secret-key');
  });
});
