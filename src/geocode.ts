// Geocoding for address items (migration 086): the installation's geocoder,
// a Nominatim-compatible search API (GEOCODER_URL, e.g. your own Nominatim,
// https://nominatim.openstreetmap.org/search within its usage policy, or
// LocationIQ's https://eu1.locationiq.com/v1/search with GEOCODER_KEY).
// Without GEOCODER_URL address items are plain text items.

export const geocoderUrl = () => {
  const u = process.env.GEOCODER_URL?.trim();
  return u && /^https?:\/\//.test(u) ? u : null;
};

export interface Place {
  label: string;
  lat: number;
  lon: number;
}

/** At most this many candidates come back. */
export const GEOCODE_MAX = 5;

/** The places that match an address (best first); throws when the geocoder can't be reached. */
export async function geocode(q: string, opts: { language?: string; country?: string | null } = {}): Promise<Place[]> {
  const base = geocoderUrl();
  if (!base) throw new Error('No geocoder: set GEOCODER_URL.');
  const url = new URL(base);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(GEOCODE_MAX));
  url.searchParams.set('q', q);
  if (opts.language) url.searchParams.set('accept-language', opts.language);
  if (opts.country && /^[a-z]{2}(,[a-z]{2})*$/i.test(opts.country)) url.searchParams.set('countrycodes', opts.country.toLowerCase());
  if (process.env.GEOCODER_KEY) url.searchParams.set('key', process.env.GEOCODER_KEY);
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': `pgkiln (${process.env.PUBLIC_URL ?? 'https://pgkiln.vargar.eu'})` },
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => ({ label: String(r?.display_name ?? '').slice(0, 300), lat: Number(r?.lat), lon: Number(r?.lon) }))
    .filter((p) => p.label && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)
    .slice(0, GEOCODE_MAX);
}
