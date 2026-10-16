/** The hexadecimal SHA-256 of a string, as secrets are stored (spec/lot-2.md section 6.3). */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `bytes` random bytes in base64url without padding. */
export function randomBase64url(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buffer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The bytes of a base64 or base64url string, padded or not. */
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Encrypts a secret with AES-GCM under the base64 key `keyBase64` (`TOKEN_ENC_KEY`), with a random
 * 12-byte IV: `v1:` followed by the base64 of the IV and the ciphertext (section 6.3).
 */
export async function encryptSecret(value: string, keyBase64: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", decodeBase64(keyBase64), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  const sealed = new Uint8Array(iv.length + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ciphertext), iv.length);
  return `v1:${base64(sealed)}`;
}
