import { useCallback, useRef, DragEvent, ChangeEvent } from 'react';

interface FileDropZoneProps {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
  accept?: string;
  multiple?: boolean;
}

export function FileDropZone({ 
  onFilesSelected, 
  disabled = false,
  accept,
  multiple = true 
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && dropRef.current) {
      dropRef.current.classList.add('border-purple-400', 'bg-purple-900/30');
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current) {
      dropRef.current.classList.remove('border-purple-400', 'bg-purple-900/30');
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (dropRef.current) {
      dropRef.current.classList.remove('border-purple-400', 'bg-purple-900/30');
    }

    if (disabled) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      onFilesSelected(multiple ? files : [files[0]]);
    }
  }, [disabled, multiple, onFilesSelected]);

  const handleClick = useCallback(() => {
    if (!disabled) {
      inputRef.current?.click();
    }
  }, [disabled]);

  const handleFileChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onFilesSelected(multiple ? files : [files[0]]);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  }, [multiple, onFilesSelected]);

  return (
    <div
      ref={dropRef}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        relative border-2 border-dashed rounded-xl p-12
        transition-all duration-200 cursor-pointer
        ${disabled 
          ? 'border-gray-600 bg-gray-800/50 cursor-not-allowed opacity-50' 
          : 'border-gray-500 hover:border-purple-400 hover:bg-purple-900/20'
        }
      `}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={accept}
        multiple={multiple}
        onChange={handleFileChange}
        disabled={disabled}
      />
      
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="text-5xl">📁</div>
        <div>
          <p className="text-xl font-medium text-white">
            {disabled ? 'Waiting for connection...' : 'Drop files here'}
          </p>
          <p className="text-gray-400 mt-1">
            {disabled ? 'Connect with a peer to start sharing' : 'or click to browse'}
          </p>
        </div>
        {!disabled && (
          <p className="text-sm text-gray-500">
            Any file type • No size limit
          </p>
        )}
      </div>
    </div>
  );
}
