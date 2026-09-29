// pgapex's own user-facing texts (login, account pages, reports, messages)
// in several languages, like APEX's translated runtime messages. An
// application can override any of them with a text message of the same
// name (Shared Components → Text messages), as in APEX.

export type Params = Record<string, string | number | null | undefined>;
export type Translate = (key: string, params?: Params) => string;

const en = {
  // sign-in
  'login.title': 'Sign in',
  'login.username': 'Username',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.with': 'Sign in with {provider}',
  'login.or': 'or',
  'login.none': 'No sign-in method is configured for this application.',
  'login.invalid': 'Invalid username or password.',
  'login.expired_session': 'Your session expired. Please try again.',
  'login.password_disabled': 'Password sign-in is not enabled for this application.',
  'login.throttled': 'Too many failed sign-in attempts. Try again in {minutes} minutes.',
  'login.forgot': 'Forgot your password?',
  'login.sign_in_link': 'Sign in',
  'login.sign_out': 'Sign out',
  'login.no_access': 'Your account ({user}) has no access to {app}. Ask an administrator.',
  'login.sso_failed': 'Sign-in failed',
  'login.sso_unavailable': 'Could not reach {provider}. Please try again later.',
  // passwords
  'password.expired.title': 'Change your password',
  'password.expired.text': 'Your password has expired or must be changed before you continue. Enter your current password and choose a new one.',
  'password.current': 'Current password',
  'password.new': 'New password',
  'password.confirm': 'Confirm new password',
  'password.change': 'Change password',
  'password.changed': 'Your password was changed.',
  'password.wrong_current': 'The current password is not correct.',
  'password.mismatch': 'The new passwords do not match.',
  'password.too_short': 'Passwords need at least {min} characters.',
  'password.needs_mixed': 'Passwords need both letters and digits.',
  'password.contains_username': 'The password must not contain the username.',
  'password.same_as_old': 'The new password must be different from the current one.',
  'password.days_left': 'Your password expires in {days} day(s).',
  // forgot password
  'forgot.title': 'Reset your password',
  'forgot.text': 'Enter your username or e-mail address. If an account with an e-mail address matches, we send it a link to choose a new password.',
  'forgot.login': 'Username or e-mail address',
  'forgot.submit': 'Send reset link',
  'forgot.sent': 'If the account exists and has an e-mail address, a reset link is on its way. The link is valid for 30 minutes.',
  'forgot.back': 'Back to sign in',
  'reset.title': 'Choose a new password',
  'reset.invalid': 'This link is invalid or has expired. Request a new one.',
  'reset.done': 'Your password was changed. You can sign in now.',
  'reset.mail.subject': 'Reset your password for {app}',
  'reset.mail.body': 'Hello {name},\n\nSomeone (hopefully you) asked to reset the password of your account "{user}" for {app}.\nChoose a new password here (valid for 30 minutes):\n\n{link}\n\nIf you didn\'t ask for this, you can ignore this e-mail; your password stays the same.',
  // account page
  'account.title': 'My account',
  'account.menu': 'My account',
  'account.details': 'Details',
  'account.username': 'Username',
  'account.name': 'Name',
  'account.email': 'E-mail',
  'account.roles': 'Roles',
  'account.preferences': 'Preferences',
  'account.saved': 'Preferences saved.',
  'account.sso_only': 'You sign in through single sign-on; change your password there.',
  'theme.label': 'Appearance',
  'theme.auto': 'Automatic (follow the device)',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'language.label': 'Language',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.back': 'Go back',
  'common.home': 'Go to the home page',
  'common.skip': 'Skip to content',
  'common.toggle_nav': 'Toggle navigation',
  'common.dismiss': 'Dismiss',
  // messages and errors
  'error.not_found': 'Not found',
  'error.app_not_found': 'Application "{app}" does not exist.',
  'error.page_not_found': 'Page {page} does not exist in {app}.',
  'error.access_denied': 'Access denied',
  'error.correct_below': 'Please correct the errors below.',
  'error.session_ended': 'Your session has ended. Please sign in again.',
  'error.required': '{label} is required.',
  'error.not_number': '{label} must be a number.',
  'error.not_date': '{label} must be a valid date.',
  'error.reference': 'An unexpected error occurred (reference #{ref}).',
  'dialog.done': 'Done.',
  'dialog.continue': 'Continue',
  // reports and regions
  'report.search': 'Search',
  'report.search_placeholder': 'Search…',
  'report.go': 'Go',
  'report.reset': 'Reset',
  'report.download': 'Download CSV',
  'report.rows': 'Rows',
  'report.rows_per_page': 'Rows per page',
  'report.no_data': 'No data found.',
  'report.range': '{from}–{to} of {total}',
  'report.previous': 'Previous',
  'report.next': 'Next',
  'report.filter': 'Filter',
  'report.actions': 'Actions',
  'report.sort_asc': 'Sort ascending',
  'report.sort_desc': 'Sort descending',
  'report.all': 'All',
  'report.remove_filter': 'Remove filter',
  'grid.add_row': 'Add row',
  'grid.save': 'Save',
  'grid.delete': 'Delete',
  'grid.saved': 'Changes saved.',
  'grid.row_error': 'Row {row}: {message}',
  'calendar.today': 'Today',
  'calendar.previous': 'Previous month',
  'calendar.next': 'Next month',
  'calendar.no_events': 'Nothing planned this month.',
  'facets.clear': 'Clear all',
  'facets.title': 'Filters',
  'chart.table': 'Data table',
  'chart.no_data': 'No data to show.',
  'lov.none': '- Select -',
  'lov.search': 'Search…',
  'item.yes': 'Yes',
  'item.no': 'No',
};

export type MessageKey = keyof typeof en;

const nl: Record<MessageKey, string> = {
  'login.title': 'Aanmelden',
  'login.username': 'Gebruikersnaam',
  'login.password': 'Wachtwoord',
  'login.submit': 'Aanmelden',
  'login.with': 'Aanmelden met {provider}',
  'login.or': 'of',
  'login.none': 'Er is geen aanmeldmethode ingesteld voor deze applicatie.',
  'login.invalid': 'Ongeldige gebruikersnaam of wachtwoord.',
  'login.expired_session': 'Je sessie is verlopen. Probeer het opnieuw.',
  'login.password_disabled': 'Aanmelden met een wachtwoord is niet ingeschakeld voor deze applicatie.',
  'login.throttled': 'Te veel mislukte aanmeldpogingen. Probeer het over {minutes} minuten opnieuw.',
  'login.forgot': 'Wachtwoord vergeten?',
  'login.sign_in_link': 'Aanmelden',
  'login.sign_out': 'Afmelden',
  'login.no_access': 'Je account ({user}) heeft geen toegang tot {app}. Vraag het een beheerder.',
  'login.sso_failed': 'Aanmelden mislukt',
  'login.sso_unavailable': '{provider} is niet bereikbaar. Probeer het later opnieuw.',
  'password.expired.title': 'Wijzig je wachtwoord',
  'password.expired.text': 'Je wachtwoord is verlopen of moet gewijzigd worden voordat je verdergaat. Vul je huidige wachtwoord in en kies een nieuw wachtwoord.',
  'password.current': 'Huidig wachtwoord',
  'password.new': 'Nieuw wachtwoord',
  'password.confirm': 'Bevestig nieuw wachtwoord',
  'password.change': 'Wachtwoord wijzigen',
  'password.changed': 'Je wachtwoord is gewijzigd.',
  'password.wrong_current': 'Het huidige wachtwoord is niet juist.',
  'password.mismatch': 'De nieuwe wachtwoorden komen niet overeen.',
  'password.too_short': 'Wachtwoorden moeten minstens {min} tekens hebben.',
  'password.needs_mixed': 'Wachtwoorden moeten letters en cijfers bevatten.',
  'password.contains_username': 'Het wachtwoord mag de gebruikersnaam niet bevatten.',
  'password.same_as_old': 'Het nieuwe wachtwoord moet anders zijn dan het huidige.',
  'password.days_left': 'Je wachtwoord verloopt over {days} dag(en).',
  'forgot.title': 'Wachtwoord opnieuw instellen',
  'forgot.text': 'Vul je gebruikersnaam of e-mailadres in. Als er een account met een e-mailadres bij hoort, sturen we een link om een nieuw wachtwoord te kiezen.',
  'forgot.login': 'Gebruikersnaam of e-mailadres',
  'forgot.submit': 'Stuur link',
  'forgot.sent': 'Als het account bestaat en een e-mailadres heeft, is er een link onderweg. De link is 30 minuten geldig.',
  'forgot.back': 'Terug naar aanmelden',
  'reset.title': 'Kies een nieuw wachtwoord',
  'reset.invalid': 'Deze link is ongeldig of verlopen. Vraag een nieuwe aan.',
  'reset.done': 'Je wachtwoord is gewijzigd. Je kunt je nu aanmelden.',
  'reset.mail.subject': 'Stel je wachtwoord voor {app} opnieuw in',
  'reset.mail.body': 'Hallo {name},\n\nIemand (hopelijk jij) heeft gevraagd het wachtwoord van je account "{user}" voor {app} opnieuw in te stellen.\nKies hier een nieuw wachtwoord (30 minuten geldig):\n\n{link}\n\nHeb je hier niet om gevraagd? Dan kun je deze e-mail negeren; je wachtwoord blijft hetzelfde.',
  'account.title': 'Mijn account',
  'account.menu': 'Mijn account',
  'account.details': 'Gegevens',
  'account.username': 'Gebruikersnaam',
  'account.name': 'Naam',
  'account.email': 'E-mail',
  'account.roles': 'Rollen',
  'account.preferences': 'Voorkeuren',
  'account.saved': 'Voorkeuren opgeslagen.',
  'account.sso_only': 'Je meldt je aan via single sign-on; wijzig je wachtwoord daar.',
  'theme.label': 'Weergave',
  'theme.auto': 'Automatisch (volg het apparaat)',
  'theme.light': 'Licht',
  'theme.dark': 'Donker',
  'language.label': 'Taal',
  'common.save': 'Opslaan',
  'common.cancel': 'Annuleren',
  'common.back': 'Terug',
  'common.home': 'Naar de startpagina',
  'common.skip': 'Naar de inhoud',
  'common.toggle_nav': 'Navigatie tonen of verbergen',
  'common.dismiss': 'Sluiten',
  'error.not_found': 'Niet gevonden',
  'error.app_not_found': 'Applicatie "{app}" bestaat niet.',
  'error.page_not_found': 'Pagina {page} bestaat niet in {app}.',
  'error.access_denied': 'Geen toegang',
  'error.correct_below': 'Verbeter de fouten hieronder.',
  'error.session_ended': 'Je sessie is beëindigd. Meld je opnieuw aan.',
  'error.required': '{label} is verplicht.',
  'error.not_number': '{label} moet een getal zijn.',
  'error.not_date': '{label} moet een geldige datum zijn.',
  'error.reference': 'Er is een onverwachte fout opgetreden (referentie #{ref}).',
  'dialog.done': 'Klaar.',
  'dialog.continue': 'Verder',
  'report.search': 'Zoeken',
  'report.search_placeholder': 'Zoeken…',
  'report.go': 'Zoek',
  'report.reset': 'Herstellen',
  'report.download': 'Download CSV',
  'report.rows': 'Rijen',
  'report.rows_per_page': 'Rijen per pagina',
  'report.no_data': 'Geen gegevens gevonden.',
  'report.range': '{from}–{to} van {total}',
  'report.previous': 'Vorige',
  'report.next': 'Volgende',
  'report.filter': 'Filter',
  'report.actions': 'Acties',
  'report.sort_asc': 'Oplopend sorteren',
  'report.sort_desc': 'Aflopend sorteren',
  'report.all': 'Alle',
  'report.remove_filter': 'Filter verwijderen',
  'grid.add_row': 'Rij toevoegen',
  'grid.save': 'Opslaan',
  'grid.delete': 'Verwijderen',
  'grid.saved': 'Wijzigingen opgeslagen.',
  'grid.row_error': 'Rij {row}: {message}',
  'calendar.today': 'Vandaag',
  'calendar.previous': 'Vorige maand',
  'calendar.next': 'Volgende maand',
  'calendar.no_events': 'Niets gepland deze maand.',
  'facets.clear': 'Alles wissen',
  'facets.title': 'Filters',
  'chart.table': 'Gegevenstabel',
  'chart.no_data': 'Geen gegevens om te tonen.',
  'lov.none': '- Kies -',
  'lov.search': 'Zoeken…',
  'item.yes': 'Ja',
  'item.no': 'Nee',
};

const BUILTIN: Record<string, Record<string, string>> = { en, nl };

/** Languages pgapex's own texts are available in. */
export const BUILTIN_LANGUAGES: [string, string][] = [['en', 'English'], ['nl', 'Nederlands']];

/** Names of languages for the language picker (in their own language). */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', nl: 'Nederlands', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', pt: 'Português',
  da: 'Dansk', sv: 'Svenska', nb: 'Norsk', fi: 'Suomi', pl: 'Polski', cs: 'Čeština', tr: 'Türkçe', el: 'Ελληνικά',
  ru: 'Русский', uk: 'Українська', ar: 'العربية', he: 'עברית', ja: '日本語', zh: '中文', ko: '한국어',
};

export const RTL = new Set(['ar', 'he', 'fa', 'ur']);

export const baseLanguage = (lang: string) => lang.toLowerCase().split('-')[0];

export function format(text: string, params?: Params) {
  return params ? text.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k]))) : text;
}

/**
 * A translator for a language: app text messages first (overrides), then
 * pgapex's built-in texts in that language, then English.
 */
export function translator(lang: string, overrides: Record<string, string> = {}): Translate {
  const own = BUILTIN[lang] ?? BUILTIN[baseLanguage(lang)] ?? {};
  return (key, params) => format(overrides[key] ?? own[key] ?? (en as Record<string, string>)[key] ?? key, params);
}

export const english = translator('en');

/**
 * Pick the best language from an Accept-Language header among the
 * available ones (exact match first, then the base language).
 */
export function fromAcceptLanguage(header: string | undefined, available: string[]) {
  if (!header) return undefined;
  const wanted = header
    .split(',')
    .map((part) => {
      const [tag, ...rest] = part.trim().split(';');
      const q = Number(rest.find((r) => r.trim().startsWith('q='))?.split('=')[1] ?? 1);
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((w) => w.tag && w.tag !== '*' && w.q > 0)
    .sort((a, b) => b.q - a.q);
  const avail = available.map((a) => a.toLowerCase());
  for (const w of wanted) {
    const exact = avail.indexOf(w.tag);
    if (exact >= 0) return available[exact];
    const base = avail.findIndex((a) => baseLanguage(a) === baseLanguage(w.tag));
    if (base >= 0) return available[base];
  }
  return undefined;
}
