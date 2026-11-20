// (086, sprint 235) The origins of the pictures a page shows from other sites.
//
// The page's Content-Security-Policy allows images from 'self' and data:
// only; a picture from another site is allowed by adding its origin to the
// response's img-src (security.ts reads ctx.imgSrc). Origins come only from
// what the page renders: a display image item's value, and the <img src> of
// template components (regions and report column templates, the built-in
// Avatar, Content Row and Media List among them). Only https URLs without
// user info count, and only the origin (scheme, host, port) is added, in its
// normalised form: never a wildcard, a path or another scheme (data: is
// already allowed for pictures; javascript: never is, and img-src can't run it).

import { decodeEntities } from '../richtext.ts';

/** At most this many origins per response (the header stays small; further pictures are blocked). */
export const MAX_IMG_ORIGINS = 50;
/** An origin as the CSP gets it: https, a host name (no IP v6 literal) and an optional port. */
const ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;

/**
 * The https URL `value` (as text, not HTML) with its origin allowed in the
 * response's img-src, or null when it is not an https URL (or the set is full
 * and doesn't have it yet).
 */
export function allowImage(imgSrc: Set<string> | null | undefined, value: string): string | null {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !ORIGIN.test(u.origin)) return null;
  if (imgSrc && !imgSrc.has(u.origin)) {
    if (imgSrc.size >= MAX_IMG_ORIGINS) return null;
    imgSrc.add(u.origin);
  }
  return u.href;
}

/** An <img src="…"> value as written in HTML (entities and all): its origin allowed when it is an https URL. */
export function allowImageAttribute(imgSrc: Set<string> | null | undefined, attrValue: string) {
  if (imgSrc) allowImage(imgSrc, decodeEntities(attrValue));
}
