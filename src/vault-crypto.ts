/**
 * Déchiffrement de l'ancien vault Open-Self (port minimal de vault-crypto.js).
 *
 * Utilisé UNIQUEMENT par migrate.ts pour la migration one-shot
 * chiffré → clair. Le store FortuneMemory v1 n'encrypte pas.
 */

import { createDecipheriv } from "node:crypto";

const ENCRYPTED_PREFIX = "enc:v1:";

export class VaultCodec {
  readonly enabled = true;
  private readonly key: Buffer;

  constructor(key: Buffer | string) {
    this.key = normalizeKey(key instanceof Buffer ? key : key);
  }

  decode(value: string, purpose = "field"): string {
    const text = String(value ?? "");
    if (!text.startsWith(ENCRYPTED_PREFIX)) return text;
    const payload = Buffer.from(text.slice(ENCRYPTED_PREFIX.length), "base64");
    if (payload.length < 28) throw new Error("payload trop court");
    const nonce = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(Buffer.from(`openself:${purpose}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

export function normalizeKey(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.length === 32) return Buffer.from(value);
    throw new Error("clé vault : 32 octets attendus");
  }
  const trimmed = String(value).trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("OPENSELF_VAULT_KEY doit être 32 octets (base64 ou hex)");
}
