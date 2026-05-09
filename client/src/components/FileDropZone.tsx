import { useCallback, useRef, DragEvent, ChangeEvent } from 'react';

interface FileDropZoneProps {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
  disabledMessage?: string;
  accept?: string;
  multiple?: boolean;
  /**
   * 'hero' makes the drop zone the visual centerpiece (large padding,
   * larger type) for empty states where the user has not yet sent
   * anything. 'compact' shrinks it once transfers are active so the
   * existing transfer cards stay above the fold.
   */
  variant?: 'hero' | 'compact';
}

export function FileDropZone({ 
  onFilesSelected, 
  disabled = false,
  disabledMessage,
  accept,
  multiple = true,
  variant = 'hero',
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && dropRef.current) {
      dropRef.current.classList.add('border-purple-400', 'bg-purple-500/10');
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current) {
      dropRef.current.classList.remove('border-purple-400', 'bg-purple-500/10');
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (dropRef.current) {
      dropRef.current.classList.remove('border-purple-400', 'bg-purple-500/10');
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

  const isHero = variant === 'hero';

  return (
    <div
      ref={dropRef}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        relative border-2 border-dashed rounded-2xl
        transition-all duration-200 cursor-pointer
        ${isHero ? 'p-12 md:p-16' : 'p-6'}
        ${disabled
          ? 'border-slate-700 bg-slate-900/40 cursor-not-allowed opacity-60'
          : 'border-slate-600 bg-slate-900/30 hover:border-purple-400 hover:bg-purple-500/5'
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

      <div className={`flex ${isHero ? 'flex-col items-center text-center gap-4' : 'flex-row items-center gap-4 text-left'}`}>
        <div className={isHero ? 'text-6xl' : 'text-3xl shrink-0'} aria-hidden>📁</div>
        <div className={isHero ? '' : 'flex-1'}>
          <p className={`font-medium text-white ${isHero ? 'text-2xl' : 'text-base'}`}>
            {disabled
              ? (disabledMessage || 'Waiting for connection...')
              : 'Drop files here'}
          </p>
          <p className={`text-slate-400 ${isHero ? 'mt-1' : ''} ${isHero ? 'text-base' : 'text-xs'}`}>
            {disabled
              ? (disabledMessage ? '' : 'Connect with a peer to start sharing')
              : 'or click to browse'}
          </p>
          {isHero && !disabled && (
            <p className="mt-2 text-sm text-slate-500">Any file type · No size limit · End-to-end encrypted</p>
          )}
        </div>
      </div>
    </div>
  );
}
