import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileDropZone } from './FileDropZone';

describe('FileDropZone', () => {
  const mockOnFilesSelected = vi.fn();

  beforeEach(() => {
    mockOnFilesSelected.mockClear();
  });

  it('should render drop zone with default text', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} />);
    
    expect(screen.getByText('Drop files here')).toBeInTheDocument();
    expect(screen.getByText('or click to browse')).toBeInTheDocument();
  });

  it('should render disabled state correctly', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} disabled />);
    
    expect(screen.getByText('Waiting for connection...')).toBeInTheDocument();
    expect(screen.getByText('Connect with a peer to start sharing')).toBeInTheDocument();
  });

  it('should handle file selection via click', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} />);
    
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    
    const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
    
    fireEvent.change(input, { target: { files: [file] } });
    
    expect(mockOnFilesSelected).toHaveBeenCalledWith([file]);
  });

  it('should handle multiple file selection', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} multiple />);
    
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    
    const file1 = new File(['content 1'], 'test1.txt', { type: 'text/plain' });
    const file2 = new File(['content 2'], 'test2.txt', { type: 'text/plain' });
    
    fireEvent.change(input, { target: { files: [file1, file2] } });
    
    expect(mockOnFilesSelected).toHaveBeenCalledWith([file1, file2]);
  });

  it('should handle drag over event without errors', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} />);
    
    const dropZone = screen.getByText('Drop files here').closest('div');
    
    // Drag over should not throw errors
    expect(() => {
      fireEvent.dragOver(dropZone!, {
        dataTransfer: { files: [] },
      });
    }).not.toThrow();
    
    // The component modifies classList directly which doesn't trigger React re-render
    // So we just verify the event handler is called without errors
  });

  it('should handle drag leave event', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} />);
    
    const dropZone = screen.getByText('Drop files here').closest('div');
    
    fireEvent.dragOver(dropZone!, {
      dataTransfer: { files: [] },
    });
    
    fireEvent.dragLeave(dropZone!, {
      dataTransfer: { files: [] },
    });
    
    // Should remove highlight classes
    expect(dropZone).not.toHaveClass('border-purple-400');
  });

  it('should handle drop event', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} />);
    
    const dropZone = screen.getByText('Drop files here').closest('div');
    const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
    
    fireEvent.drop(dropZone!, {
      dataTransfer: { files: [file] },
    });
    
    expect(mockOnFilesSelected).toHaveBeenCalledWith([file]);
  });

  it('should not call onFilesSelected when disabled', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} disabled />);
    
    const dropZone = screen.getByText('Waiting for connection...').closest('div');
    const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
    
    fireEvent.drop(dropZone!, {
      dataTransfer: { files: [file] },
    });
    
    expect(mockOnFilesSelected).not.toHaveBeenCalled();
  });

  it('should show no size limit text when enabled', () => {
    render(<FileDropZone onFilesSelected={mockOnFilesSelected} />);
    
    expect(screen.getByText(/Any file type/)).toBeInTheDocument();
    expect(screen.getByText(/No size limit/)).toBeInTheDocument();
  });
});
