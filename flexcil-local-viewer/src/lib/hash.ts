export async function sha256(bytes: Uint8Array): Promise<string> {
  const normalized = new Uint8Array(bytes.byteLength)
  normalized.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', normalized)
  const digestBytes = Array.from(new Uint8Array(digest))
  return digestBytes.map((value) => value.toString(16).padStart(2, '0')).join('')
}
