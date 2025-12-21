/**
 * Format bytes to human readable string
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Format speed to human readable string
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatFileSize(bytesPerSecond)}/s`;
}

/**
 * Format duration to human readable string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Calculate estimated time remaining
 */
export function calculateETA(bytesTransferred: number, totalBytes: number, speed: number): string {
  if (speed <= 0) return 'calculating...';
  
  const remaining = totalBytes - bytesTransferred;
  const secondsRemaining = remaining / speed;
  
  return formatDuration(secondsRemaining);
}

/**
 * Calculate progress percentage
 */
export function calculateProgress(bytesTransferred: number, totalBytes: number): number {
  if (totalBytes === 0) return 0;
  return Math.round((bytesTransferred / totalBytes) * 100);
}

/**
 * Get file extension from filename
 */
export function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Get file icon based on type
 */
export function getFileIcon(fileType: string): string {
  if (fileType.startsWith('image/')) return '🖼️';
  if (fileType.startsWith('video/')) return '🎬';
  if (fileType.startsWith('audio/')) return '🎵';
  if (fileType.startsWith('text/')) return '📄';
  if (fileType.includes('pdf')) return '📕';
  if (fileType.includes('zip') || fileType.includes('tar') || fileType.includes('rar')) return '📦';
  // Check spreadsheet before document since spreadsheetml contains 'document'
  if (fileType.includes('sheet') || fileType.includes('excel')) return '📊';
  if (fileType.includes('presentation') || fileType.includes('powerpoint')) return '📽️';
  if (fileType.includes('word') || fileType.includes('document')) return '📝';
  return '📎';
}
