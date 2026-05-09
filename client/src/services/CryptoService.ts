import type { KeyPair } from '../types';

// Adjectives for friendly names (64 words)
const ADJECTIVES = [
  'cosmic', 'swift', 'calm', 'bright', 'golden', 'silver', 'crystal', 'velvet',
  'azure', 'coral', 'amber', 'jade', 'ruby', 'sapphire', 'emerald', 'topaz',
  'lunar', 'solar', 'stellar', 'astral', 'misty', 'stormy', 'gentle', 'wild',
  'silent', 'dancing', 'floating', 'glowing', 'shining', 'blazing', 'frozen', 'fiery',
  'ancient', 'mystic', 'hidden', 'secret', 'clever', 'brave', 'noble', 'wise',
  'nimble', 'graceful', 'mighty', 'serene', 'vivid', 'radiant', 'mellow', 'bold',
  'humble', 'patient', 'eager', 'daring', 'dreamy', 'lively', 'peaceful', 'dusty',
  'snowy', 'rainy', 'sunny', 'windy', 'frosty', 'shadowy', 'sparkling', 'twilight',
];

// Nouns for friendly names (64 words)
const NOUNS = [
  'tiger', 'falcon', 'phoenix', 'dragon', 'wolf', 'bear', 'eagle', 'hawk',
  'fox', 'owl', 'raven', 'swan', 'dolphin', 'whale', 'otter', 'lynx',
  'mountain', 'river', 'ocean', 'forest', 'meadow', 'canyon', 'valley', 'island',
  'comet', 'nebula', 'aurora', 'eclipse', 'meteor', 'galaxy', 'pulsar', 'quasar',
  'willow', 'oak', 'maple', 'cedar', 'pine', 'birch', 'aspen', 'sequoia',
  'thunder', 'lightning', 'rainbow', 'sunrise', 'sunset', 'twilight', 'starlight', 'moonbeam',
  'crystal', 'diamond', 'pearl', 'opal', 'garnet', 'jasper', 'onyx', 'quartz',
  'breeze', 'storm', 'wave', 'tide', 'glacier', 'volcano', 'canyon', 'prairie',
];

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
    const signatureBytes = new Uint8Array(this.base64ToArrayBuffer(signature));
    const data = new TextEncoder().encode(challenge);

    return await crypto.subtle.verify(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      publicKey,
      signatureBytes,
      data
    );
  }

  /**
   * Sign an arbitrary byte payload (used by Phase 2 verification protocol).
   */
  async signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      data,
    );
    return this.arrayBufferToBase64(sig);
  }

  /**
   * Verify an ECDSA signature over an arbitrary byte payload.
   */
  async verifyBytes(publicKey: CryptoKey, signature: string, data: Uint8Array): Promise<boolean> {
    const sigBytes = new Uint8Array(this.base64ToArrayBuffer(signature));
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      data,
    );
  }

  /**
   * Extract the DTLS fingerprint line from an SDP. Returns the part after
   * `a=fingerprint:` (e.g. `"sha-256 ab:cd:..."`), lower-cased and trimmed.
   * The first match is returned; in practice a Sendie SDP has only one
   * fingerprint at the session or first m-line.
   */
  extractDtlsFingerprint(sdp: string): string | null {
    const m = sdp.match(/^a=fingerprint:(\S+)\s+(\S+)/m);
    if (!m) return null;
    return `${m[1].toLowerCase()} ${m[2].toLowerCase()}`;
  }

  /**
   * Canonicalize a P-256 ECDSA public JWK so that two browsers exporting
   * the same key produce byte-identical strings. We restrict to the four
   * fields required for the curve and emit them in a fixed order.
   */
  canonicalizeP256Jwk(jwkString: string): string {
    const obj = JSON.parse(jwkString) as Record<string, unknown>;
    // Only kty/crv/x/y are part of the public-key identity for P-256.
    return JSON.stringify({
      kty: obj.kty,
      crv: obj.crv,
      x: obj.x,
      y: obj.y,
    });
  }

  /**
   * Generate a SAS bound to both peers' public keys AND DTLS fingerprints.
   *
   * A passive or active server that rewrites the DTLS fingerprint in either
   * peer's SDP causes this value to differ between the two sides, which the
   * users can catch by comparing out-of-band.
   *
   * Domain-tagged and version-prefixed so future changes do not collide
   * with existing computations.
   */
  async generateBoundSAS(
    localKeyJwk: string,
    remoteKeyJwk: string,
    localFp: string,
    remoteFp: string,
    sessionId: string,
  ): Promise<string> {
    const a = [this.canonicalizeP256Jwk(localKeyJwk), localFp.toLowerCase()];
    const b = [this.canonicalizeP256Jwk(remoteKeyJwk), remoteFp.toLowerCase()];
    // Order pair canonically by JWK so both peers produce the same blob
    // regardless of which side is "local".
    const [low, high] = a[0] < b[0] ? [a, b] : [b, a];
    const blob = [
      'sendie/sas/v2',
      sessionId,
      low[0], low[1],
      high[0], high[1],
    ].join('|');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(blob));
    const hashArray = new Uint8Array(hash);
    const words = [
      WORD_LIST[hashArray[0]],
      WORD_LIST[hashArray[1]],
      WORD_LIST[hashArray[2]],
      WORD_LIST[hashArray[3]],
    ];
    return words.join('-');
  }

  /**
   * Compute the canonical bytes that both peers sign during verification.
   * Same domain tag + ordering rules as generateBoundSAS.
   */
  buildAuthPayload(
    localKeyJwk: string,
    remoteKeyJwk: string,
    localFp: string,
    remoteFp: string,
    nonceLocal: string,
    nonceRemote: string,
    sessionId: string,
  ): Uint8Array {
    const a = this.canonicalizeP256Jwk(localKeyJwk);
    const b = this.canonicalizeP256Jwk(remoteKeyJwk);
    const [lowJwk, highJwk] = a < b ? [a, b] : [b, a];
    // The nonces and fingerprints stay in (local, remote) pairing order.
    // Both sides include both nonces so an attacker cannot replay one side's
    // signature in the other direction.
    const blob = [
      'sendie/auth/v1',
      sessionId,
      lowJwk, highJwk,
      nonceLocal, nonceRemote,
      localFp.toLowerCase(), remoteFp.toLowerCase(),
    ].join('|');
    return new TextEncoder().encode(blob);
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
   * Generate a friendly name from a public key.
   *
   * Format: <adjective>-<adjective>-<noun>. With 64*64*64 = 262,144 combinations
   * the per-session collision rate at 10 peers is well under 0.02% and the SAS
   * remains the authoritative identifier; this expansion is just so the
   * friendly name doesn't become an attack vector for social engineering
   * ("that's still cosmic-tiger" — except now they have a different SAS).
   */
  async generateFriendlyName(publicKeyJwk: string): Promise<string> {
    const data = new TextEncoder().encode(publicKeyJwk);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hash);

    const adj1 = ADJECTIVES[hashArray[0] % ADJECTIVES.length];
    const adj2 = ADJECTIVES[hashArray[1] % ADJECTIVES.length];
    const noun = NOUNS[hashArray[2] % NOUNS.length];

    return `${adj1}-${adj2}-${noun}`;
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
