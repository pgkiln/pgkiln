// Application availability (APEX: Application Availability), migration 083.
// Decides whether a request may use the application: everyone (available),
// developers with a builder session in the browser (developers), the users
// named and developers (restricted), or nobody (unavailable). Pages, file
// downloads and REST modules ask here; PostgREST asks meta.api_check().
import type { MessageKey } from '../i18n.ts';

export type Availability = 'available' | 'developers' | 'restricted' | 'unavailable';

export interface AvailabilitySettings {
  availability?: Availability | null;
  availability_message?: string | null;
  availability_users?: string[] | null;
}

export interface Refusal {
  status: 403 | 503;
  /** the default text; the application's own message replaces it when it is unavailable or for developers only */
  key: MessageKey;
  message: string | null;
  /** restricted and not signed in: sign in first */
  signIn?: boolean;
}

/** Null when the request may go on, else why not. */
export function availabilityRefusal(app: AvailabilitySettings, who: { username: string | null; developer: boolean }): Refusal | null {
  const mode = app.availability ?? 'available';
  if (mode === 'available') return null;
  const message = app.availability_message?.trim() || null;
  if (mode === 'unavailable') return { status: 503, key: 'app.unavailable', message };
  if (who.developer) return null;
  if (mode === 'developers') return { status: 503, key: 'app.developers_only', message };
  // restricted
  if (!who.username) return { status: 403, key: 'app.restricted', message: null, signIn: true };
  const user = who.username.toLowerCase();
  return (app.availability_users ?? []).some((u) => u.toLowerCase() === user) ? null : { status: 403, key: 'app.restricted', message: null };
}
