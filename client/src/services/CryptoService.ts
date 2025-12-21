import type { KeyPair } from '../types';

// Word list for SAS code generation (256 words for 1 byte each)
const WORD_LIST = [
  'apple', 'banana', 'cherry', 'delta', 'eagle', 'forest', 'garden', 'harbor',
  'island', 'jungle', 'kingdom', 'lemon', 'mountain', 'nature', 'ocean', 'planet',
  'quantum', 'river', 'sunset', 'thunder', 'umbrella', 'valley', 'winter', 'xylophone',
  'yellow', 'zebra', 'anchor', 'bridge', 'castle', 'diamond', 'eclipse', 'falcon',
  'glacier', 'horizon', 'infinity', 'jasmine', 'knight', 'lantern', 'meadow', 'nebula',
  'orchid', 'phoenix', 'quartz', 'rainbow', 'sapphire', 'temple', 'universe', 'volcano',
  'willow', 'xenon', 'yacht', 'zenith', 'amber', 'breeze', 'coral', 'dawn',
  'ember', 'flame', 'galaxy', 'haven', 'iris', 'jade', 'karma', 'lotus',
  'marble', 'nectar', 'opal', 'pearl', 'quest', 'radiant', 'silver', 'topaz',
  'unity', 'velvet', 'whisper', 'zephyr', 'atlas', 'blaze', 'crest', 'drift',
  'echo', 'flare', 'glow', 'haze', 'ivory', 'jewel', 'kindle', 'luna',
  'mist', 'nova', 'orbit', 'prism', 'quill', 'realm', 'spark', 'tide',
  'ultra', 'vivid', 'wave', 'azure', 'bloom', 'crystal', 'dusk', 'evergreen',
  'fern', 'grace', 'hollow', 'indigo', 'jubilee', 'keystone', 'lily', 'moss',
  'nimbus', 'olive', 'pebble', 'quiver', 'ripple', 'shade', 'thorn', 'umber',
  'vine', 'wren', 'apex', 'brook', 'cedar', 'dove', 'elm', 'frost',
  'granite', 'heath', 'inlet', 'juniper', 'kelp', 'laurel', 'maple', 'north',
  'oak', 'pine', 'quince', 'reed', 'sage', 'tulip', 'upland', 'violet',
  'wisteria', 'yarrow', 'zinnia', 'aspen', 'birch', 'clover', 'daisy', 'eucalyptus',
  'fig', 'ginger', 'hazel', 'ivy', 'jasper', 'kale', 'lavender', 'mint',
  'nettle', 'onyx', 'poppy', 'quinoa', 'rose', 'sequoia', 'thyme', 'ursa',
  'vanilla', 'walnut', 'xeranthemum', 'yew', 'zest', 'agate', 'basil', 'citrus',
  'daffodil', 'ebony', 'fennel', 'garnet', 'hemp', 'iris', 'jonquil', 'kumquat',
  'larch', 'magnolia', 'nutmeg', 'oregano', 'parsley', 'quaking', 'rosemary', 'saffron',
  'tarragon', 'ursine', 'verbena', 'wheat', 'xylem', 'yucca', 'zinnia', 'acacia',
  'bamboo', 'carnation', 'dahlia', 'elderberry', 'freesia', 'geranium', 'hibiscus', 'impatiens',
  'jasmine', 'kiwi', 'lilac', 'marigold', 'narcissus', 'oleander', 'petunia', 'quince',
  'ranunculus', 'sunflower', 'tansy', 'ulmus', 'viburnum', 'wattle', 'xerophyte', 'yarrow',
  'zinnia', 'almond', 'bergamot', 'chamomile', 'dandelion', 'echinacea', 'foxglove', 'goldenrod',
  'honeysuckle', 'ironwood', 'jessamine', 'kudzu', 'lupine', 'mullein', 'nightshade', 'oxalis',
  'primrose', 'queen', 'ragwort', 'snapdragon', 'trillium', 'ulex', 'valerian', 'woodruff',
  'xanthium', 'yellowwood', 'zenobia', 'azalea', 'buttercup', 'columbine', 'delphinium', 'edelweiss'
];

export class CryptoService {
  /**
   * Generate an ECDSA key pair for identity verification
   */
  async generateKeyPair(): Promise<KeyPair> {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true, // extractable - needed to export public key
      ['sign', 'verify']
    );

    return {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    };
  }

  /**
   * Export a public key to JWK format for transmission
   */
  async exportPublicKey(key: CryptoKey): Promise<string> {
    const jwk = await crypto.subtle.exportKey('jwk', key);
    return JSON.stringify(jwk);
  }

  /**
   * Import a public key from JWK format
   */
  async importPublicKey(jwkString: string): Promise<CryptoKey> {
    const jwk = JSON.parse(jwkString) as JsonWebKey;
    return await crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true,
      ['verify']
    );
  }

  /**
   * Generate a random challenge for signature verification
   */
  generateChallenge(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return this.arrayBufferToBase64(bytes.buffer);
  }

  /**
   * Sign a challenge with the private key
   */
  async sign(privateKey: CryptoKey, challenge: string): Promise<string> {
    const data = new TextEncoder().encode(challenge);
    const signature = await crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      privateKey,
      data
    );
    return this.arrayBufferToBase64(signature);
  }

  /**
   * Verify a signature using the public key
   */
  async verify(publicKey: CryptoKey, signature: string, challenge: string): Promise<boolean> {
    const signatureBuffer = this.base64ToArrayBuffer(signature);
    const data = new TextEncoder().encode(challenge);
    
    return await crypto.subtle.verify(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      publicKey,
      signatureBuffer,
      data
    );
  }

  /**
   * Generate a Short Authentication String (SAS) from two public keys
   * Users can compare these codes out-of-band to verify no MITM attack
   */
  async generateSAS(localKeyJwk: string, remoteKeyJwk: string): Promise<string> {
    // Sort keys to ensure both sides generate the same SAS
    const combined = [localKeyJwk, remoteKeyJwk].sort().join('|');
    
    const data = new TextEncoder().encode(combined);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hash);

    // Use first 4 bytes to generate 4 words
    const words = [
      WORD_LIST[hashArray[0]],
      WORD_LIST[hashArray[1]],
      WORD_LIST[hashArray[2]],
      WORD_LIST[hashArray[3]],
    ];

    return words.join('-');
  }

  /**
   * Generate a unique file ID
   */
  generateFileId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Hash file data for integrity verification (SHA-256)
   */
  async hashData(data: ArrayBuffer): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return this.arrayBufferToBase64(hash);
  }

  // Utility functions
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

export const cryptoService = new CryptoService();
