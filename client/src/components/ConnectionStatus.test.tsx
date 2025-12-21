import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionStatusDisplay } from './ConnectionStatus';

describe('ConnectionStatusDisplay', () => {
  it('should show disconnected status', () => {
    render(
      <ConnectionStatusDisplay 
        status="disconnected" 
        sessionId={null} 
        connectedPeerCount={0}
        maxPeers={10}
        error={null} 
      />
    );
    
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText('○')).toBeInTheDocument();
  });

  it('should show connecting status', () => {
    render(
      <ConnectionStatusDisplay 
        status="connecting" 
        sessionId="abc123" 
        connectedPeerCount={0}
        maxPeers={10}
        error={null} 
      />
    );
    
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
    expect(screen.getByText('◐')).toBeInTheDocument();
  });

  it('should show waiting for peer status', () => {
    render(
      <ConnectionStatusDisplay 
        status="waiting-for-peer" 
        sessionId="abc123" 
        connectedPeerCount={0}
        maxPeers={10}
        error={null} 
      />
    );
    
    expect(screen.getByText('Waiting for peers...')).toBeInTheDocument();
    expect(screen.getByText('◑')).toBeInTheDocument();
  });

  it('should show connected status', () => {
    render(
      <ConnectionStatusDisplay 
        status="connected" 
        sessionId="abc123" 
        connectedPeerCount={2}
        maxPeers={10}
        error={null} 
      />
    );
    
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('●')).toBeInTheDocument();
  });

  it('should show verified status', () => {
    render(
      <ConnectionStatusDisplay 
        status="verified" 
        sessionId="abc123" 
        connectedPeerCount={1}
        maxPeers={10}
        error={null} 
      />
    );
    
    expect(screen.getByText('Verified & Connected')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('should show error status', () => {
    render(
      <ConnectionStatusDisplay 
        status="error" 
        sessionId={null} 
        connectedPeerCount={0}
        maxPeers={10}
        error="Connection failed" 
      />
    );
    
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('✕')).toBeInTheDocument();
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  it('should display session ID when provided', () => {
    render(
      <ConnectionStatusDisplay 
        status="connected" 
        sessionId="abc123" 
        connectedPeerCount={1}
        maxPeers={10}
        error={null} 
      />
    );
    
    expect(screen.getByText('abc123')).toBeInTheDocument();
  });

  it('should display peer count when connected', () => {
    render(
      <ConnectionStatusDisplay 
        status="connected" 
        sessionId="abc123" 
        connectedPeerCount={3}
        maxPeers={10}
        error={null} 
      />
    );
    
    expect(screen.getByText(/3 peers connected/)).toBeInTheDocument();
  });

  it('should show max peers for multi-peer sessions', () => {
    render(
      <ConnectionStatusDisplay 
        status="connected" 
        sessionId="abc123" 
        connectedPeerCount={2}
        maxPeers={10}
        error={null} 
      />
    );
    
    expect(screen.getByText(/max 10/)).toBeInTheDocument();
  });

  it('should not display error when null', () => {
    render(
      <ConnectionStatusDisplay 
        status="connected" 
        sessionId="abc123" 
        connectedPeerCount={1}
        maxPeers={10}
        error={null} 
      />
    );
    
    // Error message should not be present
    const container = screen.getByText('Connected').closest('div')?.parentElement;
    expect(container?.textContent).not.toContain('error');
  });
});
