// Personal web-link tokens: stored AES-256-GCM encrypted (so the link can be shown again)
// with a separate HMAC column for lookups.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface TokenCodec {
  newToken(): string;
  encrypt(token: string): string;
  decrypt(stored: string): string;
  hmac(token: string): string;
}

// New tokens are 43 chars; 22-char tokens from before stay valid until rotated.
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$|^[A-Za-z0-9_-]{43}$/;

export function parseLinkSecret(value: string): Buffer {
  const secret = Buffer.from(value.trim(), 'base64');
  if (secret.length !== 32) throw new Error('WEB_LINK_SECRET must be 32 bytes, base64 encoded (pnpm gen-secret).');
  return secret;
}

export function createTokenCodec(secretBase64: string): TokenCodec {
  const secret = parseLinkSecret(secretBase64);
  const derive = (label: string) => createHmac('sha256', secret).update(label).digest();
  const encKey = derive('ffe-token-enc');
  const macKey = derive('ffe-token-mac');
  return {
    newToken: () => randomBytes(32).toString('base64url'),
    encrypt(token) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    },
    decrypt(stored) {
      const raw = Buffer.from(stored, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
    hmac: (token) => createHmac('sha256', macKey).update(token).digest('base64url'),
  };
}
