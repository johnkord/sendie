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
    render(<SessionLink sessionId="abc123" />);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toContain('/s/abc123');
  });

  it('should render copy button', () => {
    render(<SessionLink sessionId="abc123" />);
    
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('should copy link to clipboard when copy button clicked', async () => {
    render(<SessionLink sessionId="abc123" />);
    
    const copyButton = screen.getByText('Copy');
    fireEvent.click(copyButton);
    
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('/s/abc123')
      );
    });
  });

  it('should show copied confirmation after clicking', async () => {
    render(<SessionLink sessionId="abc123" />);
    
    const copyButton = screen.getByText('Copy');
    fireEvent.click(copyButton);
    
    await waitFor(() => {
      expect(screen.getByText('✓ Copied!')).toBeInTheDocument();
    });
  });

  it('should display instruction text', () => {
    render(<SessionLink sessionId="abc123" />);
    
    expect(screen.getByText(/Share this link/)).toBeInTheDocument();
  });

  it('should have read-only input', () => {
    render(<SessionLink sessionId="abc123" />);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
  });

  it('should generate correct URL format', () => {
    render(<SessionLink sessionId="xyz789" />);
    
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toMatch(/^http.*\/s\/xyz789$/);
  });
});
