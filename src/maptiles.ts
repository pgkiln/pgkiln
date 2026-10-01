// Map tiles (map regions): the URL template, its attribution, and the origin the
// Content-Security-Policy must allow images from. MAP_TILE_URL points to another
// tile server (your own, or a commercial one) when OpenStreetMap's policy doesn't fit.

export const tileUrl = () => process.env.MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const tileAttribution = () => process.env.MAP_ATTRIBUTION ?? '© OpenStreetMap contributors';

/** https://tile.example.com, or https://*.tile.example.com for {s}.tile… templates; null when not http(s). */
export function tileOrigin() {
  try {
    const sub = /\/\/\{s\}\./.test(tileUrl());
    const u = new URL(tileUrl().replace(/\{[a-z]\}/g, 'a'));
    if (!/^https?:$/.test(u.protocol)) return null;
    return sub ? `${u.protocol}//*.${u.host.replace(/^a\./, '')}` : u.origin;
  } catch {
    return null;
  }
}
