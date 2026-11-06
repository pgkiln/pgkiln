import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import type { BuilderTranslate } from './i18n.ts';
import { input } from './ui.ts';

// (sprint 165, migration 154) Settings → User Interface → Notifications: the notification bell
// (meta.app.notifications) and live badges (meta.app.live_badges_s, 10 to 3600 seconds or none).

/** The fields, in the User Interface tab of the application's settings. */
export function notificationSettings(a: { notifications?: boolean | null; live_badges_s?: number | null }, tx: BuilderTranslate) {
  return html`<h3 id="notifications">${tx('nfy.heading')}</h3>
    <input type="hidden" name="notification_settings" value="1">
    <div class="field"><label class="check"><input type="checkbox" name="notifications" value="true"${a.notifications ? raw(' checked') : ''}> ${tx('nfy.bell')}</label>
      <small class="help">${tx.code('nfy.bell_help')}</small></div>
    <div class="form-grid">
      ${input('live_badges_s', tx('nfy.live'), a.live_badges_s ?? '', { type: 'number', placeholder: tx('nfy.live_ph'), help: tx('nfy.live_help') })}
    </div>`;
}

/** Save them (only when the form had them); a number outside 10 to 3600 is an error. */
export async function saveNotificationSettings(appId: string, b: Record<string, string | undefined>, tx: BuilderTranslate) {
  if (b.notification_settings !== '1') return;
  const raw = (b.live_badges_s ?? '').trim();
  const seconds = raw === '' ? null : Number(raw);
  if (seconds !== null && !(Number.isInteger(seconds) && seconds >= 10 && seconds <= 3600)) throw new Error(tx('nfy.live_invalid'));
  await owner.query('update meta.app set notifications = $2, live_badges_s = $3 where id = $1', [appId, b.notifications === 'true', seconds]);
}
