import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransferProgress } from './TransferProgress';
import type { TransferState } from '../types';

describe('TransferProgress', () => {
  const baseTransfer: TransferState = {
    fileId: 'file-123',
    fileName: 'test-document.pdf',
    fileSize: 1024 * 1024, // 1 MB
    fileType: 'application/pdf',
    direction: 'send',
    status: 'transferring',
    bytesTransferred: 512 * 1024, // 512 KB
    startTime: Date.now() - 5000, // Started 5 seconds ago
    speed: 102400, // ~100 KB/s
  };

  it('should render file name', () => {
    render(<TransferProgress transfer={baseTransfer} />);
    
    expect(screen.getByText('test-document.pdf')).toBeInTheDocument();
  });

  it('should show sending direction', () => {
    render(<TransferProgress transfer={baseTransfer} />);
    
    expect(screen.getByText('↑ Sending')).toBeInTheDocument();
  });

  it('should show receiving direction', () => {
    const receiveTransfer = { ...baseTransfer, direction: 'receive' as const };
    render(<TransferProgress transfer={receiveTransfer} />);
    
    expect(screen.getByText('↓ Receiving')).toBeInTheDocument();
  });

  it('should display transfer progress', () => {
    render(<TransferProgress transfer={baseTransfer} />);
    
    // Should show bytes transferred
    expect(screen.getByText(/512.*KB.*\/.*1\.0.*MB/i)).toBeInTheDocument();
  });

  it('should display transfer speed', () => {
    render(<TransferProgress transfer={baseTransfer} />);
    
    expect(screen.getByText(/100.*KB\/s/i)).toBeInTheDocument();
  });

  it('should show progress percentage', () => {
    render(<TransferProgress transfer={baseTransfer} />);
    
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('should show completed status', () => {
    const completedTransfer: TransferState = {
      ...baseTransfer,
      status: 'completed',
      bytesTransferred: baseTransfer.fileSize,
    };
    
    render(<TransferProgress transfer={completedTransfer} />);
    
    expect(screen.getByText('✓ Complete')).toBeInTheDocument();
  });

  it('should show failed status', () => {
    const failedTransfer: TransferState = {
      ...baseTransfer,
      status: 'failed',
    };
    
    render(<TransferProgress transfer={failedTransfer} />);
    
    expect(screen.getByText('✕ Failed')).toBeInTheDocument();
  });

  it('should show cancelled status', () => {
    const cancelledTransfer: TransferState = {
      ...baseTransfer,
      status: 'cancelled',
    };
    
    render(<TransferProgress transfer={cancelledTransfer} />);
    
    expect(screen.getByText('✕ Cancelled')).toBeInTheDocument();
  });

  it('should show cancel button for active transfer', () => {
    const onCancel = vi.fn();
    render(<TransferProgress transfer={baseTransfer} onCancel={onCancel} />);
    
    const cancelButton = screen.getByText('Cancel');
    expect(cancelButton).toBeInTheDocument();
  });

  it('should call onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(<TransferProgress transfer={baseTransfer} onCancel={onCancel} />);
    
    const cancelButton = screen.getByText('Cancel');
    fireEvent.click(cancelButton);
    
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('should not show cancel button for completed transfer', () => {
    const onCancel = vi.fn();
    const completedTransfer: TransferState = {
      ...baseTransfer,
      status: 'completed',
    };
    
    render(<TransferProgress transfer={completedTransfer} onCancel={onCancel} />);
    
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
  });

  it('should show file type icon', () => {
    render(<TransferProgress transfer={baseTransfer} />);
    
    // PDF should show book icon
    expect(screen.getByText('📕')).toBeInTheDocument();
  });

  it('should show image icon for images', () => {
    const imageTransfer: TransferState = {
      ...baseTransfer,
      fileType: 'image/png',
    };
    
    render(<TransferProgress transfer={imageTransfer} />);
    
    expect(screen.getByText('🖼️')).toBeInTheDocument();
  });

  it('should show pending status', () => {
    const pendingTransfer: TransferState = {
      ...baseTransfer,
      status: 'pending',
      bytesTransferred: 0,
      speed: 0,
    };
    
    render(<TransferProgress transfer={pendingTransfer} />);
    
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
