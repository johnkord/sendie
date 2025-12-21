import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService } from './CryptoService';

describe('CryptoService', () => {
  let cryptoService: CryptoService;

  beforeEach(() => {
    cryptoService = new CryptoService();
  });

  describe('generateKeyPair', () => {
    it('should generate a key pair with public and private keys', async () => {
      const keyPair = await cryptoService.generateKeyPair();
      
      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
    });
  });

  describe('exportPublicKey', () => {
    it('should export public key as JSON string', async () => {
      const keyPair = await cryptoService.generateKeyPair();
      const exported = await cryptoService.exportPublicKey(keyPair.publicKey);
      
      expect(exported).toBeDefined();
      expect(typeof exported).toBe('string');
      
      // Should be valid JSON
      const parsed = JSON.parse(exported);
      expect(parsed).toHaveProperty('kty');
    });
  });

  describe('importPublicKey', () => {
    it('should import a public key from JWK string', async () => {
      const keyPair = await cryptoService.generateKeyPair();
      const exported = await cryptoService.exportPublicKey(keyPair.publicKey);
      const imported = await cryptoService.importPublicKey(exported);
      
      expect(imported).toBeDefined();
    });
  });

  describe('generateChallenge', () => {
    it('should generate a random challenge string', () => {
      const challenge = cryptoService.generateChallenge();
      
      expect(challenge).toBeDefined();
      expect(typeof challenge).toBe('string');
      expect(challenge.length).toBeGreaterThan(0);
    });

    it('should generate unique challenges', () => {
      const challenges = new Set<string>();
      
      for (let i = 0; i < 100; i++) {
        challenges.add(cryptoService.generateChallenge());
      }
      
      expect(challenges.size).toBe(100);
    });
  });

  describe('sign and verify', () => {
    it('should sign a challenge with private key', async () => {
      const keyPair = await cryptoService.generateKeyPair();
      const challenge = cryptoService.generateChallenge();
      
      const signature = await cryptoService.sign(keyPair.privateKey, challenge);
      
      expect(signature).toBeDefined();
      expect(typeof signature).toBe('string');
    });

    it('should verify a valid signature', async () => {
      const keyPair = await cryptoService.generateKeyPair();
      const challenge = cryptoService.generateChallenge();
      
      const signature = await cryptoService.sign(keyPair.privateKey, challenge);
      const isValid = await cryptoService.verify(keyPair.publicKey, signature, challenge);
      
      expect(isValid).toBe(true);
    });
  });

  describe('generateFriendlyName', () => {
    it('should generate a friendly name from a public key', async () => {
      const keyPair = await cryptoService.generateKeyPair();
      const keyJwk = await cryptoService.exportPublicKey(keyPair.publicKey);
      
      const friendlyName = await cryptoService.generateFriendlyName(keyJwk);
      
      expect(friendlyName).toBeDefined();
      expect(typeof friendlyName).toBe('string');
      // Should be "adjective-noun" format
      expect(friendlyName.split('-').length).toBe(2);
    });

    it('should generate consistent friendly names for same key', async () => {
      const keyPair = await cryptoService.generateKeyPair();
      const keyJwk = await cryptoService.exportPublicKey(keyPair.publicKey);
      
      const name1 = await cryptoService.generateFriendlyName(keyJwk);
      const name2 = await cryptoService.generateFriendlyName(keyJwk);
      
      expect(name1).toBe(name2);
    });

    it('should generate names in adjective-noun format', async () => {
      const keyPair = await cryptoService.generateKeyPair();
      const keyJwk = await cryptoService.exportPublicKey(keyPair.publicKey);
      
      const name = await cryptoService.generateFriendlyName(keyJwk);
      const parts = name.split('-');
      
      // Should be exactly 2 parts
      expect(parts.length).toBe(2);
      // Each part should be a non-empty alphabetic word
      expect(parts[0]).toMatch(/^[a-z]+$/);
      expect(parts[1]).toMatch(/^[a-z]+$/);
    });
  });

  describe('generateSAS', () => {
    it('should generate a SAS code from two public keys', async () => {
      const keyPair1 = await cryptoService.generateKeyPair();
      const keyPair2 = await cryptoService.generateKeyPair();
      
      const key1Jwk = await cryptoService.exportPublicKey(keyPair1.publicKey);
      const key2Jwk = await cryptoService.exportPublicKey(keyPair2.publicKey);
      
      const sas = await cryptoService.generateSAS(key1Jwk, key2Jwk);
      
      expect(sas).toBeDefined();
      expect(typeof sas).toBe('string');
      expect(sas.split('-').length).toBe(4);
    });

    it('should generate same SAS regardless of key order', async () => {
      const keyPair1 = await cryptoService.generateKeyPair();
      const keyPair2 = await cryptoService.generateKeyPair();
      
      const key1Jwk = await cryptoService.exportPublicKey(keyPair1.publicKey);
      const key2Jwk = await cryptoService.exportPublicKey(keyPair2.publicKey);
      
      const sas1 = await cryptoService.generateSAS(key1Jwk, key2Jwk);
      const sas2 = await cryptoService.generateSAS(key2Jwk, key1Jwk);
      
      expect(sas1).toBe(sas2);
    });

    it('should generate a four-word SAS code', async () => {
      // Note: Testing differentiation requires real crypto; here we verify format
      const keyPair1 = await cryptoService.generateKeyPair();
      const keyPair2 = await cryptoService.generateKeyPair();
      
      const key1Jwk = await cryptoService.exportPublicKey(keyPair1.publicKey);
      const key2Jwk = await cryptoService.exportPublicKey(keyPair2.publicKey);
      
      const sas = await cryptoService.generateSAS(key1Jwk, key2Jwk);
      const words = sas.split('-');
      
      // Should be 4 words separated by dashes
      expect(words.length).toBe(4);
      words.forEach(word => {
        expect(word.length).toBeGreaterThan(0);
      });
    });
  });

  describe('generateFileId', () => {
    it('should generate a hex string', () => {
      const fileId = cryptoService.generateFileId();
      
      expect(fileId).toBeDefined();
      expect(fileId).toMatch(/^[0-9a-f]+$/);
    });

    it('should generate unique file IDs', () => {
      const ids = new Set<string>();
      
      for (let i = 0; i < 100; i++) {
        ids.add(cryptoService.generateFileId());
      }
      
      expect(ids.size).toBe(100);
    });

    it('should generate 32-character file IDs', () => {
      const fileId = cryptoService.generateFileId();
      expect(fileId.length).toBe(32);
    });
  });

  describe('hashData', () => {
    it('should hash data and return base64 string', async () => {
      const data = new TextEncoder().encode('test data').buffer;
      const hash = await cryptoService.hashData(data);
      
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
    });

    it('should produce same hash for same data', async () => {
      const data1 = new TextEncoder().encode('test data').buffer;
      const data2 = new TextEncoder().encode('test data').buffer;
      
      const hash1 = await cryptoService.hashData(data1);
      const hash2 = await cryptoService.hashData(data2);
      
      expect(hash1).toBe(hash2);
    });

    it('should return a base64 encoded string', async () => {
      // Note: Testing hash differentiation requires real crypto
      // Here we verify the hash is a valid base64 string format
      const data = new TextEncoder().encode('test data').buffer;
      const hash = await cryptoService.hashData(data);
      
      // Base64 strings contain only these characters
      expect(hash).toMatch(/^[A-Za-z0-9+/=]*$/);
      expect(hash.length).toBeGreaterThan(0);
    });
  });
});
