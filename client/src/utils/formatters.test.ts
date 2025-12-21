import { describe, it, expect } from 'vitest';
import {
  formatFileSize,
  formatSpeed,
  formatDuration,
  calculateETA,
  calculateProgress,
  getFileExtension,
  getFileIcon,
  sanitizeFilename,
} from '../utils/formatters';

describe('formatters', () => {
  describe('formatFileSize', () => {
    it('should format 0 bytes', () => {
      expect(formatFileSize(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1.0 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
      expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    });

    it('should format gigabytes', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    });

    it('should format terabytes', () => {
      expect(formatFileSize(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB');
    });
  });

  describe('formatSpeed', () => {
    it('should format speed with /s suffix', () => {
      expect(formatSpeed(1024)).toBe('1.0 KB/s');
      expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s');
    });

    it('should handle zero speed', () => {
      expect(formatSpeed(0)).toBe('0 B/s');
    });
  });

  describe('formatDuration', () => {
    it('should format seconds', () => {
      expect(formatDuration(30)).toBe('30s');
      expect(formatDuration(59)).toBe('59s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(60)).toBe('1m 0s');
      expect(formatDuration(90)).toBe('1m 30s');
      expect(formatDuration(3599)).toBe('59m 59s');
    });

    it('should format hours and minutes', () => {
      expect(formatDuration(3600)).toBe('1h 0m');
      expect(formatDuration(3660)).toBe('1h 1m');
      expect(formatDuration(7200)).toBe('2h 0m');
    });
  });

  describe('calculateETA', () => {
    it('should return calculating when speed is 0', () => {
      expect(calculateETA(500, 1000, 0)).toBe('calculating...');
    });

    it('should calculate remaining time', () => {
      // 500 bytes remaining at 100 bytes/s = 5 seconds
      expect(calculateETA(500, 1000, 100)).toBe('5s');
    });

    it('should handle completed transfer', () => {
      expect(calculateETA(1000, 1000, 100)).toBe('0s');
    });

    it('should format longer durations', () => {
      // 6000 bytes remaining at 100 bytes/s = 60 seconds = 1 minute
      expect(calculateETA(0, 6000, 100)).toBe('1m 0s');
    });
  });

  describe('calculateProgress', () => {
    it('should return 0 for zero total', () => {
      expect(calculateProgress(100, 0)).toBe(0);
    });

    it('should calculate percentage correctly', () => {
      expect(calculateProgress(0, 100)).toBe(0);
      expect(calculateProgress(50, 100)).toBe(50);
      expect(calculateProgress(100, 100)).toBe(100);
    });

    it('should round to nearest integer', () => {
      expect(calculateProgress(33, 100)).toBe(33);
      expect(calculateProgress(1, 3)).toBe(33);
    });
  });

  describe('getFileExtension', () => {
    it('should return extension for normal files', () => {
      expect(getFileExtension('document.pdf')).toBe('pdf');
      expect(getFileExtension('image.PNG')).toBe('png');
    });

    it('should return empty string for files without extension', () => {
      expect(getFileExtension('README')).toBe('');
    });

    it('should handle multiple dots', () => {
      expect(getFileExtension('archive.tar.gz')).toBe('gz');
    });
  });

  describe('getFileIcon', () => {
    it('should return image icon for images', () => {
      expect(getFileIcon('image/png')).toBe('🖼️');
      expect(getFileIcon('image/jpeg')).toBe('🖼️');
    });

    it('should return video icon for videos', () => {
      expect(getFileIcon('video/mp4')).toBe('🎬');
    });

    it('should return audio icon for audio', () => {
      expect(getFileIcon('audio/mpeg')).toBe('🎵');
    });

    it('should return text icon for text files', () => {
      expect(getFileIcon('text/plain')).toBe('📄');
    });

    it('should return PDF icon for PDFs', () => {
      expect(getFileIcon('application/pdf')).toBe('📕');
    });

    it('should return archive icon for compressed files', () => {
      expect(getFileIcon('application/zip')).toBe('📦');
      expect(getFileIcon('application/x-tar')).toBe('📦');
      expect(getFileIcon('application/x-rar-compressed')).toBe('📦');
    });

    it('should return document icon for office documents', () => {
      expect(getFileIcon('application/msword')).toBe('📝');
      expect(getFileIcon('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('📝');
    });

    it('should return spreadsheet icon for spreadsheets', () => {
      expect(getFileIcon('application/vnd.ms-excel')).toBe('📊');
      expect(getFileIcon('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('📊');
    });

    it('should return presentation icon for presentations', () => {
      expect(getFileIcon('application/vnd.ms-powerpoint')).toBe('📽️');
    });

    it('should return default icon for unknown types', () => {
      expect(getFileIcon('application/octet-stream')).toBe('📎');
      expect(getFileIcon('unknown/type')).toBe('📎');
    });
  });

  describe('sanitizeFilename', () => {
    it('should return unchanged for safe filenames', () => {
      expect(sanitizeFilename('document.pdf')).toBe('document.pdf');
      expect(sanitizeFilename('my-file_v2.txt')).toBe('my-file_v2.txt');
    });

    it('should remove path traversal sequences', () => {
      expect(sanitizeFilename('../../../etc/passwd')).toBe('etc_passwd');
      expect(sanitizeFilename('..\\..\\windows\\system32')).toBe('windows_system32');
      expect(sanitizeFilename('file/../secret.txt')).toBe('file_secret.txt');
    });

    it('should remove directory separators', () => {
      expect(sanitizeFilename('/etc/passwd')).toBe('etc_passwd');
      expect(sanitizeFilename('C:\\Windows\\System32')).toBe('C_Windows_System32');
      expect(sanitizeFilename('path/to/file.txt')).toBe('path_to_file.txt');
    });

    it('should remove dangerous characters', () => {
      expect(sanitizeFilename('file<script>.txt')).toBe('file_script_.txt');
      expect(sanitizeFilename('file|name.txt')).toBe('file_name.txt');
      expect(sanitizeFilename('file:name.txt')).toBe('file_name.txt');
      expect(sanitizeFilename('file"name.txt')).toBe('file_name.txt');
      expect(sanitizeFilename('file?name.txt')).toBe('file_name.txt');
      expect(sanitizeFilename('file*name.txt')).toBe('file_name.txt');
    });

    it('should handle null bytes', () => {
      expect(sanitizeFilename('file\x00name.txt')).toBe('filename.txt');
    });

    it('should remove control characters', () => {
      expect(sanitizeFilename('file\x01\x02name.txt')).toBe('filename.txt');
    });

    it('should collapse multiple underscores', () => {
      expect(sanitizeFilename('file___name.txt')).toBe('file_name.txt');
    });

    it('should remove leading/trailing dots and spaces', () => {
      expect(sanitizeFilename('  file.txt  ')).toBe('file.txt');
      expect(sanitizeFilename('.hidden')).toBe('hidden');
      expect(sanitizeFilename('file.txt.')).toBe('file.txt');
    });

    it('should handle path traversal that results in leading dots/underscores', () => {
      // '...' becomes '_' then stripped = 'unnamed_file'
      expect(sanitizeFilename('...')).toBe('unnamed_file');
      // '...file.txt...' becomes '_file.txt_' then stripped = 'file.txt'
      expect(sanitizeFilename('...file.txt...')).toBe('file.txt');
    });

    it('should limit filename length', () => {
      const longName = 'a'.repeat(300) + '.txt';
      const result = sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(255);
    });

    it('should return fallback for empty/invalid input', () => {
      expect(sanitizeFilename('')).toBe('unnamed_file');
      expect(sanitizeFilename('   ')).toBe('unnamed_file');
      expect(sanitizeFilename('...')).toBe('unnamed_file');
      expect(sanitizeFilename(null as unknown as string)).toBe('unnamed_file');
      expect(sanitizeFilename(undefined as unknown as string)).toBe('unnamed_file');
    });

    it('should handle complex malicious filenames', () => {
      expect(sanitizeFilename('../../<script>alert("xss")</script>.html')).toBe('script_alert(_xss_)_script_.html');
      expect(sanitizeFilename('CON.txt')).toBe('CON.txt'); // Windows reserved names are kept (browser handles)
    });
  });
});
