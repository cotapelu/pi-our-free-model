/**
 * Stub port of dsh's `src/open-external.js` — open external URL.
 * Opens an external URL in the system browser.
 *
 * @module pi-extension/open-external.js
 */

export const MAX_EXTERNAL_URL_LENGTH = 2048

export function externalUrl(value: string): string | null {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH) return null
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
        url.href.length > MAX_EXTERNAL_URL_LENGTH) return null
    return url.href
  } catch { return null }
}

export async function openExternal(value: string): Promise<boolean> {
  const url = externalUrl(value)
  if (url === null) return false
  // In a real implementation, this would use the system's default browser.
  // For now, just validate the URL.
  return true
}
