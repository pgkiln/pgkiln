import { advise } from './advisor.ts';
import { appLocks, isAdmin, lockPanel, lockText } from './locks.ts';
import { parseRoleList, validRoleName } from '../dbauth.ts';
import { DEFAULT_HEADER, headerProxiesConfigured } from '../headerauth.ts';
import { appIssues } from './team.ts';
import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon, LUCIDE_VERSION, searchIcons } from '../icons.ts';
import { appStyles, BASE_STYLES, baseStyleOf } from '../runtime/styles.ts';
import { APP_TYPE_LABELS, APP_TYPES } from '../subscriptions.ts';
import { pwaSection } from './pwa.ts';
import { documentShell } from '../layout.ts';
import { passwordProblem } from '../accounts.ts';
import { clientIp, createSession, destroySession, getSession, loginThrottled, logActivity, saveState, takeFlash } from '../session.ts';
import { loginSettingsFields, saveLoginSettings } from './login-page.ts';
import { APP_COLORS, appHeader, back, BASE, brandMark, designerUrl, builderHead, csrf, developer, flash, input, region, select, send, shell, THEME_COOKIE, validTheme, type Req } from './ui.ts';
import { appOr404 } from './forms.ts';
import { docToFiles, filesToZip } from '../appfiles.ts';
import { homeRoutes, rememberApp } from './home.ts';
import { currentWorkspace, placeApp, workshopDb, workspaceRoutes } from './workspaces.ts';
import { securityRoutes } from './security.ts';
import { instanceRoutes } from './instance.ts';
import { saveTimeZoneSettings, timeZoneSettings } from './globalization.ts';
import { WIZARD_KINDS, wizardRoutes, wizardTables } from './wizards.ts';
import { appFromFileRoutes } from './appfromfile.ts';
import { clearDevbar } from '../runtime/devbar.ts';
import { EMAIL } from './find-workspace.ts';
import { cookieLanguage, LANG_COOKIE, tr, translatorFor, validBuilderLanguage } from './i18n.ts';
import { checkSecondFactor, codesLeft, forgetBrowsers, hasFactor, isTrustedBrowser, leavesTooFewAdmins, passkeyByCredential, passkeySignin, passkeysOf, trustBrowser, trustDays, usePasskey, userHandle } from '../mfa.ts';
import { isIP } from 'node:net';
import { giveChallenge, takeChallenge } from './security.ts';
import { relyingParty, verifyAssertion, WebAuthnError } from '../webauthn.ts';
import { chooseLanguage, langCookieOptions, languageRoutes, signInLanguageLinks } from './language.ts';
import { builderSsoRoutes, leavesNoBreakGlass } from './builder-sso.ts';
import { builderDirectory, builderProvider, builderSources, linkDeveloper, resolveDeveloper, ssoRequired } from '../devsso.ts';
import { ldapAuthenticate, LdapError } from '../ldap.ts';
import { onBuilderSso, SsoError, startSignIn } from '../sso.ts';
import { startSamlSignIn } from '../saml.ts';

// Builder pages: sign-in, workspace and app home, settings, activity and
// developers. Shared Components, the page designer and the SQL Workshop
// are in shared.ts, designer.ts and sql.ts.

export async function builderRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- login
  // (sprint 61, APEX: the workspace sign-in page) workspace (optional), username and password;
  // "Remember workspace and username" keeps both in a cookie of the builder's path
  const REMEMBER_COOKIE = 'pgkiln_bsignin';
  const remembered = (req: Req): { w: string; u: string } | null => {
    try {
      const v = JSON.parse(Buffer.from(String(req.cookies?.[REMEMBER_COOKIE] ?? ''), 'base64url').toString('utf8'));
      return typeof v?.w === 'string' && typeof v?.u === 'string' ? { w: v.w.slice(0, 60), u: v.u.slice(0, 100) } : null;
    } catch {
      return null;
    }
  };
  /** Where to go after signing in: a builder page only. */
  const safeNext = (v: unknown) => (typeof v === 'string' && /^\/builder(\/[A-Za-z0-9_/-]{0,200})?$/.test(v) ? v : `${BASE}/home`);

  app.get(`${BASE}/login`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    if (s.username) return reply.redirect(`${BASE}/home`);
    // (sprint 121) a language link (?lang=de) sets the sign-in page's language: a cookie, and this visit's choice
    // (stored for the developer who signs in next, see the post below); an unknown code is ignored
    const picked = validBuilderLanguage(req.query?.lang);
    if (picked) {
      s.state.__BLANG = picked;
      reply.setCookie(LANG_COOKIE, picked, langCookieOptions());
    }
    const tx = translatorFor(picked ?? validBuilderLanguage(s.state.__BLANG) ?? cookieLanguage(req));
    const error = takeFlash(s, '__ERROR');
    await saveState(s);
    const r = remembered(req);
    const next = safeNext(req.query?.next);
    // (sprint 128) a passkey alone, when the instance allows it and the address is a host name
    const alone = (await passkeySignin()) && !isIP(relyingParty(req).rpId);
    // (sprint 129, SEC-1) identity providers and directories that sign developers in
    const sources = await builderSources();
    const field = (name: string, label: string, ic: string, value: string, opts: { type?: string; required?: boolean; auto?: string; placeholder?: string; reveal?: boolean }) =>
      html`<div class="field signin-field"><label class="sr-only" for="f_${name}">${label}</label>
        <div class="signin-input">${icon(ic)}<input id="f_${name}" name="${name}" type="${opts.type ?? 'text'}" value="${value}" placeholder="${opts.placeholder ?? label}"${opts.required ? raw(' required') : ''}${opts.auto ? raw(` autocomplete="${opts.auto}"`) : ''}>
          ${opts.reveal ? html`<button type="button" class="signin-reveal" data-reveal="f_${name}" aria-controls="f_${name}" aria-pressed="false" data-hide="${tx('signin.hide')}" hidden>${tx('signin.show')}</button>` : ''}</div></div>`;
    return reply.type('text/html').send(
      documentShell(
        `${tx('signin.title')} · ${tx('shell.builder')}`,
        html`<main class="signin">
          <section class="signin-hero" aria-label="pgkiln">
            <span class="signin-logo" aria-hidden="true">${brandMark()}</span>
            <h1 class="signin-title">pgkiln</h1>
            <p class="signin-tagline">${tx('signin.tagline')}</p>
            <p class="signin-foot">${tx('signin.license')}</p>
          </section>
          <section class="signin-panel">
            <form method="post" class="signin-form">
              <h2>${tx('signin.welcome')}</h2>
              <p class="muted u-mt0">${tx('signin.intro')}</p>
              ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
              ${csrf(s)}<input type="hidden" name="next" value="${next}">
              ${field('workspace', tx('signin.workspace'), 'database', r?.w ?? '', { placeholder: tx('signin.workspace_placeholder'), auto: 'organization' })}
              ${sources.directories.length ? html`<div class="field signin-field"><label class="sr-only" for="f_method">${tx('signin.method')}</label>
                <div class="signin-input">${icon('server')}<select id="f_method" name="method" aria-label="${tx('signin.method')}">
                  <option value="">${tx('signin.method_pgkiln')}</option>
                  ${sources.directories.map((d) => html`<option value="ldap:${d.name}">${d.display_name}</option>`)}</select></div></div>` : ''}
              ${field('username', tx('signin.username'), 'user', r?.u ?? '', { required: true, auto: 'username' })}
              ${field('password', tx('signin.password'), 'key', '', { type: 'password', required: true, auto: 'current-password', reveal: true })}
              <label class="check signin-remember"><input type="checkbox" name="remember" value="1"${r ? raw(' checked') : ''}> ${tx('signin.remember')}</label>
              <button class="btn btn-hot signin-submit">${tx('signin.submit')}</button>
              ${alone ? html`<input type="hidden" name="credentialId"><input type="hidden" name="clientDataJSON"><input type="hidden" name="authenticatorData"><input type="hidden" name="signature"><input type="hidden" name="userHandle">
                <button class="btn signin-submit signin-passkey" hidden data-passkey="${BASE}/login/passkey/options" data-passkey-submit="${BASE}/login/passkey" data-passkey-error="${tx('mfa.passkey_failed')}">${icon('fingerprint')} ${tx('signin.passkey')}</button>
                <p class="small" role="status" data-passkey-status></p>` : ''}
              ${sources.providers.map((p) => html`<a class="btn signin-submit signin-idp" href="${BASE}/sso/${p.name}${next === `${BASE}/home` ? '' : `?next=${encodeURIComponent(next)}`}">${icon('log-in')} ${tx('signin.with', { provider: p.display_name })}</a>`)}
              <p class="muted small signin-hint">${tx('signin.hint')}</p>
              <nav class="signin-actions" aria-label="${tx('signin.quick')}">
                <a href="${BASE}/find-workspace">${icon('search')} ${tx('signin.find_ws')}</a>
                <a href="${BASE}/login?next=${encodeURIComponent(`${BASE}/utilities`)}">${icon('settings')} ${tx('signin.admin')}</a>
                <a href="https://github.com/pgkiln/pgkiln/blob/main/docs/guide/03-builder.md#workspaces" target="_blank" rel="noopener">${icon('help')} ${tx('signin.about_ws')}</a>
              </nav>
              ${signInLanguageLinks(tx.lang, next, tx('signin.languages'))}
            </form>
          </section>
        </main>`,
        'login-body ide-login signin-body',
        {},
        builderHead(),
        { theme: validTheme(req.cookies?.[THEME_COOKIE]) ?? 'dark', lang: tx.lang },
      ),
    );
  });

  app.post(`${BASE}/login`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    const { username = '', password = '' } = req.body ?? {};
    const workspace = String(req.body?.workspace ?? '').trim().slice(0, 60);
    const next = safeNext(req.body?.next);
    const again = next === `${BASE}/home` ? `${BASE}/login` : `${BASE}/login?next=${encodeURIComponent(next)}`;
    const ip = clientIp(req);
    // (sprint 121) the language chosen on the sign-in page in this visit (a link), else the device's
    const picked = validBuilderLanguage(s.state.__BLANG);
    const tx = translatorFor(picked ?? cookieLanguage(req));
    if (req.body?.__csrf !== s.csrf_token) {
      flash(s, tx('signin.expired'), 'error');
      return back(reply, s, again);
    }
    if (await loginThrottled(null, username, ip)) {
      logActivity({ username, event: 'login_locked', ip, detail: 'builder' });
      flash(s, tx('signin.throttled'), 'error');
      return back(reply, s, again);
    }
    // (sprint 129, SEC-1) an LDAP directory checks the password; the developer is the one linked to the entry
    const method = String(req.body?.method ?? '');
    const directory = method.startsWith('ldap:') ? await builderDirectory(method.slice(5)) : undefined;
    if (method && !directory) {
      flash(s, tx('signin.expired'), 'error');
      return back(reply, s, again);
    }
    let dev: { username: string; language: string | null } | undefined;
    if (directory) {
      let why = 'invalid';
      try {
        const u = await ldapAuthenticate(directory, username, password);
        if (u) {
          const name = await resolveDeveloper({ kind: 'directory', ...directory }, { subject: u.subject, username: u.username, name: u.displayName, email: u.email, mayLink: true, groups: u.groups });
          dev = await owner.one('select username, language from meta.developer where username = $1', [name]);
        }
      } catch (e) {
        if (!(e instanceof SsoError)) req.log.warn({ err: e, directory: directory.name }, 'builder ldap sign-in failed');
        why = e instanceof SsoError ? e.message : e instanceof LdapError ? e.message : 'unreachable';
      }
      if (!dev) {
        await logActivity({ username: username.slice(0, 100), event: 'login_failed', ip, detail: `builder ldap:${directory.name}: ${why}` });
        flash(s, why === 'invalid' ? tx('signin.invalid') : why === 'unreachable' ? tx('signin.ldap_unavailable', { directory: directory.display_name }) : why, 'error');
        return back(reply, s, again);
      }
    } else
      // bcrypt always runs (dummy salt for unknown users) so timing does not reveal accounts
      dev = await owner.one(
        `select d.username, d.language
           from (select $1::text as u) x
           left join meta.developer d on d.username = x.u
          where crypt($2, coalesce(d.password_hash, gen_salt('bf', 10))) = d.password_hash`,
        [username, password],
      );
    // a workspace, when given, must be one of the developer's (administrators: any); the same answer otherwise
    const ws = dev && workspace ? await workspaceOf(workspace, dev.username) : undefined;
    if (!dev || (workspace && !ws)) {
      await logActivity({ username: username.slice(0, 100), event: 'login_failed', ip, detail: directory ? `builder ldap:${directory.name} (workspace)` : workspace ? 'builder (workspace)' : 'builder' });
      flash(s, tx(workspace ? 'signin.invalid_ws' : 'signin.invalid'), 'error');
      return back(reply, s, again);
    }
    // (sprint 129) a workspace of the developer requires single sign-on: not the pgkiln password (break-glass excepted)
    if (!directory && (await ssoRequired(dev.username))) {
      await logActivity({ username: dev.username, event: 'login_failed', ip, detail: 'builder: single sign-on required' });
      flash(s, tx('signin.sso_required'), 'error');
      return back(reply, s, again);
    }
    const weak = !directory && (password === 'admin' || password === dev.username);
    const detail = directory ? `builder ldap:${directory.name}` : 'builder';
    // (sprint 126, SEC-2) a developer with a second factor: the password was right, the session comes after the code;
    // (sprint 127) unless this browser was trusted after a second factor, for the instance's number of days
    if ((await hasFactor(dev.username)) && !(await isTrustedBrowser(dev.username, req.cookies?.[TRUST_COOKIE]))) {
      s.state.__MFA = JSON.stringify({ u: dev.username, ws: ws ? String(ws.id) : null, w: workspace, next, remember: req.body?.remember === '1', weak, at: Date.now() });
      await saveState(s);
      return reply.redirect(`${BASE}/login/2fa`, 303);
    }
    return finishSignIn(req, reply, s, { username: dev.username, language: dev.language }, { ws: ws ? String(ws.id) : null, workspace, next, remember: req.body?.remember === '1', weak, picked, detail });
  });

  /** A workspace by name, when it is one of the developer's (administrators: any). */
  const workspaceOf = (workspace: string, username: string) =>
    owner.one<{ id: number }>(
      `select w.id from meta.workspace w
        where lower(w.name) = lower($1)
          and (exists (select 1 from meta.developer d where d.username = $2 and d.is_admin)
               or exists (select 1 from meta.workspace_member m where m.workspace_id = w.id and m.username = $2))`,
      [workspace, username],
    );

  // (sprint 129, SEC-1) signing in through an identity provider (OpenID Connect or SAML; devsso.ts). The
  // provider returns to the runtime's callback (/sso/…, registered at the provider for applications too),
  // which hands sign-ins without an application to the function below.
  const SSO_COOKIE = 'pgkiln_sso';
  app.get(`${BASE}/sso/:provider`, async (req: Req, reply) => {
    const p = await builderProvider(String(req.params.provider));
    if (!p) return reply.code(404).send('Not found');
    try {
      const next = safeNext(req.query?.next);
      const { url, browserKey } = p.protocol === 'saml' ? await startSamlSignIn(p, null, next) : await startSignIn(p, null, next);
      reply.setCookie(SSO_COOKIE, browserKey, { path: '/sso', httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 600 });
      return reply.redirect(url);
    } catch (e) {
      req.log.warn({ err: e }, 'builder sso start failed');
      const s = await getSession(req, reply, null, BASE);
      flash(s, translatorFor(validBuilderLanguage(s.state.__BLANG) ?? cookieLanguage(req))('signin.sso_unavailable', { provider: p.display_name }), 'error');
      return back(reply, s, `${BASE}/login`);
    }
  });
  /** Linking an identity from the Security page (security.ts): the signed-in developer starts it. */
  app.post(`${BASE}/security/link/:provider`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = await builderProvider(String(req.params.provider));
    if (!p) return reply.code(404).send('Not found');
    try {
      const { url, browserKey } = p.protocol === 'saml' ? await startSamlSignIn(p, null, `${BASE}/security`, s.username!) : await startSignIn(p, null, `${BASE}/security`, s.username!);
      reply.setCookie(SSO_COOKIE, browserKey, { path: '/sso', httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 600 });
      return reply.redirect(url, 303);
    } catch (e) {
      req.log.warn({ err: e }, 'builder sso link failed');
      flash(s, tr(s)('signin.sso_unavailable', { provider: p.display_name }), 'error');
      return back(reply, s, `${BASE}/security`);
    }
  });
  // the end of both (the runtime's callback; SsoError → an error page there)
  onBuilderSso(async (req: Req, reply, p, result, ip) => {
    if (!p.builder || !result.identity) throw new SsoError('This identity provider does not sign developers in.');
    const src = { kind: 'provider' as const, ...p };
    if (result.link) {
      // the browser that started this was signed in as result.link (the start needs the session and its CSRF token)
      await linkDeveloper(src, result.identity.subject, result.link);
      logActivity({ username: result.link, event: 'sso_linked', ip, detail: p.name });
      return reply.redirect(`${BASE}/security?linked=${encodeURIComponent(p.name)}`, 303);
    }
    const username = await resolveDeveloper(src, { ...result.identity, username: result.username, groups: result.groups });
    const dev = await owner.one<{ username: string; language: string | null }>('select username, language from meta.developer where username = $1', [username]);
    if (!dev) throw new SsoError('The developer was removed.');
    return finishSignIn(req, reply, null, dev, { ws: null, workspace: '', next: safeNext(result.next), remember: false, weak: false, picked: null, detail: `builder sso:${p.name}`, sso: p.name });
  });

  // (sprint 128, SEC-2) signing in with a passkey alone: no user name, no password. The browser offers the
  // passkeys it holds for this site (discoverable credentials); the authenticator must verify the developer
  // (fingerprint, face, PIN), so the passkey counts as both factors. Failures count with wrong passwords.
  app.post(`${BASE}/login/passkey/options`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    if (req.body?.__csrf !== s.csrf_token) return reply.code(403).send('Reload the page.');
    if (!(await passkeySignin())) return reply.code(404).send('Passkey sign-in is off.');
    const challenge = giveChallenge(s as Parameters<typeof giveChallenge>[0], 'get');
    await saveState(s);
    reply.header('cache-control', 'no-store');
    return reply.send({ mode: 'get', challenge, rpId: relyingParty(req).rpId, allow: [], uv: 'required' });
  });
  app.post(`${BASE}/login/passkey`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    const ip = clientIp(req);
    const picked = validBuilderLanguage(s.state.__BLANG);
    const tx = translatorFor(picked ?? cookieLanguage(req));
    const workspace = String(req.body?.workspace ?? '').trim().slice(0, 60);
    const next = safeNext(req.body?.next);
    const again = next === `${BASE}/home` ? `${BASE}/login` : `${BASE}/login?next=${encodeURIComponent(next)}`;
    const challenge = takeChallenge(s as Parameters<typeof takeChallenge>[0], 'get');
    if (req.body?.__csrf !== s.csrf_token || !(await passkeySignin())) {
      flash(s, tx('signin.expired'), 'error');
      return back(reply, s, again);
    }
    const rp = relyingParty(req);
    const key = await passkeyByCredential(String(req.body?.credentialId ?? ''), rp.rpId);
    const who = key?.username ?? '';
    if (await loginThrottled(null, who, ip)) {
      logActivity({ username: who, event: 'login_locked', ip, detail: 'builder passkey' });
      flash(s, tx('signin.throttled'), 'error');
      return back(reply, s, again);
    }
    let why = key ? '' : 'unknown passkey';
    if (key && !challenge) why = 'no or an expired challenge';
    else if (key && req.body?.userHandle && req.body.userHandle !== userHandle(key.username)) why = 'the user handle does not match';
    else if (key && challenge) {
      try {
        const r = verifyAssertion(
          { clientDataJSON: String(req.body?.clientDataJSON ?? ''), authenticatorData: String(req.body?.authenticatorData ?? ''), signature: String(req.body?.signature ?? '') },
          { alg: key.alg, jwk: key.public_key, signCount: Number(key.sign_count) }, { challenge, ...rp });
        if (!r.userVerified) why = 'the authenticator did not verify the user';
        else if (!(await usePasskey(key.id, key.sign_count, r.signCount))) why = 'used at the same time elsewhere';
      } catch (e) {
        why = e instanceof WebAuthnError ? e.message : 'unreadable answer';
      }
    }
    const ws = !why && workspace ? await workspaceOf(workspace, who) : undefined;
    if (!why && workspace && !ws) why = 'not a workspace of the developer';
    // (sprint 129) a passkey alone is not single sign-on
    if (!why && (await ssoRequired(who))) why = 'single sign-on required';
    if (why) {
      await logActivity({ username: who.slice(0, 100), event: 'login_failed', ip, detail: `builder passkey: ${why}` });
      flash(s, tx(why === 'not a workspace of the developer' ? 'signin.invalid_ws' : why === 'single sign-on required' ? 'signin.sso_required' : 'mfa.passkey_failed'), 'error');
      return back(reply, s, again);
    }
    const dev = await owner.one<{ username: string; language: string | null }>('select username, language from meta.developer where username = $1', [who]);
    if (!dev) return back(reply, s, again);
    return finishSignIn(req, reply, s, dev, { ws: ws ? String(ws.id) : null, workspace, next, remember: req.body?.remember === '1', weak: false, picked, detail: 'builder passkey' });
  });

  /**
   * The session after a successful sign-in (password, and the second factor when the developer has one;
   * or an identity provider, sso: its name; s null: the sign-in page's session is not at hand there).
   */
  async function finishSignIn(req: Req, reply: Parameters<typeof back>[0], s: Awaited<ReturnType<typeof getSession>> | null, dev: { username: string; language: string | null },
    o: { ws: string | null; workspace: string; next: string; remember: boolean; weak: boolean; picked: ReturnType<typeof validBuilderLanguage>; detail: string; sso?: string }) {
    const ip = clientIp(req);
    const { picked, next, workspace } = o;
    if (s) await destroySession(reply, s, BASE);
    const ns = await createSession(reply, null, BASE, dev.username);
    // the builder theme chosen earlier on this device
    const theme = validTheme(req.cookies?.[THEME_COOKIE]);
    if (theme) ns.state.__BTHEME = theme;
    if (o.ws) ns.state.__WS = o.ws;
    // (sprint 121) the builder language: a link chosen on the sign-in page is stored for the developer; else theirs
    if (picked) await chooseLanguage(reply, ns, picked);
    else {
      ns.state.__BLANG = validBuilderLanguage(dev.language) ?? 'en';
      if (dev.language && ns.state.__BLANG !== 'en') reply.setCookie(LANG_COOKIE, ns.state.__BLANG, langCookieOptions());
    }
    if (o.weak) ns.state.__WEAK = '1';
    // (sprint 129) the identity provider decided on the second factor: no enrolment in pgkiln (ui.ts)
    if (o.sso) ns.state.__SSO = o.sso;
    await saveState(ns);
    if (o.sso) {
      // the sign-in page's "remember" stays as it was
    } else if (o.remember)
      reply.setCookie(REMEMBER_COOKIE, Buffer.from(JSON.stringify({ w: workspace, u: dev.username })).toString('base64url'), {
        path: BASE, httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600, secure: process.env.COOKIE_SECURE === 'true',
      });
    else reply.clearCookie(REMEMBER_COOKIE, { path: BASE });
    logActivity({ username: dev.username, event: 'login', ip, detail: o.detail });
    return reply.redirect(next, 303);
  }

  // (sprint 126, SEC-2) the second step: a code from the authenticator app, or a recovery code;
  // (sprint 127) or a passkey, and "trust this browser" when the instance allows it
  const MFA_SECONDS = 300;
  const TRUST_COOKIE = 'pgkiln_btrust';
  const trustThisBrowser = async (req: Req, reply: Parameters<typeof back>[0], username: string) => {
    const days = await trustDays();
    if (!days || req.body?.trust !== '1') return;
    const token = await trustBrowser(username, days, String(req.headers['user-agent'] ?? ''));
    reply.setCookie(TRUST_COOKIE, token, { path: BASE, httpOnly: true, sameSite: 'lax', maxAge: days * 86400, secure: process.env.COOKIE_SECURE === 'true' });
    logActivity({ username, event: '2fa_trusted_browser', ip: clientIp(req), detail: `${days} days` });
  };
  const pendingMfa = (s: { state: Record<string, any> }) => {
    try {
      const p = JSON.parse(String(s.state.__MFA ?? ''));
      return p && typeof p.u === 'string' && Date.now() - Number(p.at) < MFA_SECONDS * 1000 ? p as { u: string; ws: string | null; w: string; next: string; remember: boolean; weak: boolean } : null;
    } catch {
      return null;
    }
  };
  app.get(`${BASE}/login/2fa`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    if (s.username) return reply.redirect(`${BASE}/home`);
    const p = pendingMfa(s);
    const tx = translatorFor(validBuilderLanguage(s.state.__BLANG) ?? cookieLanguage(req));
    if (!p) {
      delete s.state.__MFA;
      flash(s, tx('mfa.expired'), 'error');
      return back(reply, s, `${BASE}/login`);
    }
    const error = takeFlash(s, '__ERROR');
    await saveState(s);
    const [keys, days] = await Promise.all([passkeysOf(p.u, relyingParty(req).rpId), trustDays()]);
    return reply.type('text/html').send(documentShell(
      `${tx('mfa.step_title')} · ${tx('shell.builder')}`,
      html`<main class="signin">
        <section class="signin-hero" aria-label="pgkiln">
          <span class="signin-logo" aria-hidden="true">${brandMark()}</span>
          <h1 class="signin-title">pgkiln</h1>
          <p class="signin-tagline">${tx('signin.tagline')}</p>
        </section>
        <section class="signin-panel">
          <form method="post" class="signin-form">
            <h2>${tx('mfa.step_title')}</h2>
            <p class="muted u-mt0">${tx('mfa.step_intro', { user: p.u })}</p>
            ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
            ${csrf(s)}
            ${keys.length ? html`<input type="hidden" name="credentialId"><input type="hidden" name="clientDataJSON"><input type="hidden" name="authenticatorData"><input type="hidden" name="signature">
              <button class="btn btn-hot signin-submit" hidden data-passkey="${BASE}/login/2fa/passkey/options" data-passkey-submit="${BASE}/login/2fa/passkey" data-passkey-error="${tx('mfa.passkey_failed')}">${icon('fingerprint')} ${tx('mfa.use_passkey')}</button>
              <p class="small" role="status" data-passkey-status></p>` : ''}
            <div class="field signin-field"><label class="label" for="f_code">${tx('mfa.code')}</label>
              <div class="signin-input">${icon('key')}<input id="f_code" name="code" required autocomplete="one-time-code" autofocus maxlength="20" spellcheck="false" autocapitalize="off"></div>
              <small class="help">${tx('mfa.code_help')}</small></div>
            ${days ? html`<label class="check"><input type="checkbox" name="trust" value="1"> ${tx('mfa.trust_browser', { days })}</label>` : ''}
            <button class="btn${keys.length ? '' : ' btn-hot'} signin-submit">${tx('mfa.verify')}</button>
            <p class="muted small signin-hint"><a href="${BASE}/login">${tx('mfa.cancel')}</a> · ${tx('mfa.locked_out')}</p>
          </form>
        </section>
      </main>`,
      'login-body ide-login signin-body', {}, builderHead(),
      { theme: validTheme(req.cookies?.[THEME_COOKIE]) ?? 'dark', lang: tx.lang },
    ));
  });
  app.post(`${BASE}/login/2fa`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    const ip = clientIp(req);
    const picked = validBuilderLanguage(s.state.__BLANG);
    const tx = translatorFor(picked ?? cookieLanguage(req));
    const p = pendingMfa(s);
    if (req.body?.__csrf !== s.csrf_token || !p) {
      delete s.state.__MFA;
      flash(s, tx(p ? 'signin.expired' : 'mfa.expired'), 'error');
      return back(reply, s, `${BASE}/login`);
    }
    if (await loginThrottled(null, p.u, ip)) {
      logActivity({ username: p.u, event: 'login_locked', ip, detail: 'builder 2fa' });
      delete s.state.__MFA;
      flash(s, tx('signin.throttled'), 'error');
      return back(reply, s, `${BASE}/login`);
    }
    const ok = await checkSecondFactor(p.u, String(req.body?.code ?? '').slice(0, 40));
    if (!ok) {
      // counts with the failed passwords (lockout after the same number of attempts)
      await logActivity({ username: p.u, event: 'login_failed', ip, detail: 'builder 2fa' });
      flash(s, tx('mfa.wrong'), 'error');
      return back(reply, s, `${BASE}/login/2fa`);
    }
    const dev = await owner.one<{ username: string; language: string | null }>('select username, language from meta.developer where username = $1', [p.u]);
    if (!dev) return back(reply, s, `${BASE}/login`);
    if (ok.kind === 'recovery') {
      const left = await codesLeft(p.u);
      await logActivity({ username: p.u, event: '2fa_recovery_used', ip, detail: `${left} left` });
      // to the Security page: one code fewer, maybe time for new ones
      await trustThisBrowser(req, reply, p.u);
      return finishSignIn(req, reply, s, dev, { ws: p.ws, workspace: p.w, next: `${BASE}/security`, remember: p.remember, weak: p.weak, picked, detail: 'builder 2fa (recovery code)' });
    }
    await trustThisBrowser(req, reply, p.u);
    return finishSignIn(req, reply, s, dev, { ws: p.ws, workspace: p.w, next: p.next, remember: p.remember, weak: p.weak, picked, detail: 'builder 2fa' });
  });

  // (sprint 127) the second step with a passkey: options for navigator.credentials.get(), then the browser's answer
  app.post(`${BASE}/login/2fa/passkey/options`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    const p = pendingMfa(s);
    if (req.body?.__csrf !== s.csrf_token || !p) return reply.code(403).send('Sign in again.');
    const rp = relyingParty(req);
    const keys = await passkeysOf(p.u, rp.rpId);
    if (!keys.length) return reply.code(404).send('No passkey for this site.');
    const challenge = giveChallenge(s as Parameters<typeof giveChallenge>[0], 'get');
    await saveState(s);
    reply.header('cache-control', 'no-store');
    return reply.send({ mode: 'get', challenge, rpId: rp.rpId, allow: keys.map((k) => ({ id: k.credential_id, transports: k.transports })) });
  });
  app.post(`${BASE}/login/2fa/passkey`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    const ip = clientIp(req);
    const picked = validBuilderLanguage(s.state.__BLANG);
    const tx = translatorFor(picked ?? cookieLanguage(req));
    const p = pendingMfa(s);
    const challenge = takeChallenge(s as Parameters<typeof takeChallenge>[0], 'get');
    if (req.body?.__csrf !== s.csrf_token || !p) {
      delete s.state.__MFA;
      flash(s, tx(p ? 'signin.expired' : 'mfa.expired'), 'error');
      return back(reply, s, `${BASE}/login`);
    }
    if (await loginThrottled(null, p.u, ip)) {
      logActivity({ username: p.u, event: 'login_locked', ip, detail: 'builder 2fa' });
      delete s.state.__MFA;
      flash(s, tx('signin.throttled'), 'error');
      return back(reply, s, `${BASE}/login`);
    }
    const rp = relyingParty(req);
    const key = (await passkeysOf(p.u, rp.rpId)).find((k) => k.credential_id === String(req.body?.credentialId ?? ''));
    let why = 'unknown passkey';
    if (key && challenge) {
      try {
        const r = verifyAssertion(
          { clientDataJSON: String(req.body?.clientDataJSON ?? ''), authenticatorData: String(req.body?.authenticatorData ?? ''), signature: String(req.body?.signature ?? '') },
          { alg: key.alg, jwk: key.public_key, signCount: Number(key.sign_count) }, { challenge, ...rp });
        if (await usePasskey(key.id, key.sign_count, r.signCount)) why = '';
        else why = 'used at the same time elsewhere';
      } catch (e) {
        why = e instanceof WebAuthnError ? e.message : 'unreadable answer';
      }
    } else if (!challenge) why = 'no or an expired challenge';
    if (why) {
      await logActivity({ username: p.u, event: 'login_failed', ip, detail: `builder 2fa passkey: ${why}` });
      flash(s, tx('mfa.passkey_failed'), 'error');
      return back(reply, s, `${BASE}/login/2fa`);
    }
    const dev = await owner.one<{ username: string; language: string | null }>('select username, language from meta.developer where username = $1', [p.u]);
    if (!dev) return back(reply, s, `${BASE}/login`);
    await trustThisBrowser(req, reply, p.u);
    return finishSignIn(req, reply, s, dev, { ws: p.ws, workspace: p.w, next: p.next, remember: p.remember, weak: p.weak, picked, detail: 'builder 2fa (passkey)' });
  });

  app.post(`${BASE}/logout`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    if (req.body?.__csrf === s.csrf_token) {
      await destroySession(reply, s, BASE);
      clearDevbar(reply);
    }
    return reply.redirect(`${BASE}/login`, 303);
  });

  // The builder's light/dark theme (the developer's menu in the icon rail).
  app.post(`${BASE}/theme`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const theme = validTheme(req.body?.theme);
    if (!theme) return reply.code(400).send('Unknown theme');
    s.state.__BTHEME = theme;
    reply.setCookie(THEME_COOKIE, theme, { path: BASE, httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600, secure: process.env.COOKIE_SECURE === 'true' });
    const ref = String(req.headers.referer ?? '');
    const back_to = (() => {
      try {
        const u = new URL(ref);
        return u.host === req.headers.host && u.pathname.startsWith(BASE) ? u.pathname + u.search : BASE;
      } catch {
        return BASE;
      }
    })();
    return back(reply, s, back_to);
  });

  // the workspace pages (App Builder home, Create, Import, Dashboard, Utilities) are in home.ts
  await homeRoutes(app);
  await languageRoutes(app);
  await workspaceRoutes(app);
  await instanceRoutes(app);
  await securityRoutes(app);
  await builderSsoRoutes(app);
  await wizardRoutes(app);
  await appFromFileRoutes(app);

  // (sprint 73) POST /apps, creating an application, is in appwizard.ts

  // (sprint 74) hide the default-password warning until the next sign-in (the avatar keeps a dot)
  app.post(`${BASE}/weak/dismiss`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    s.state.__WEAK_HIDDEN = '1';
    return back(reply, s, BASE);
  });

  app.post(`${BASE}/import`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    try {
      const ws = currentWorkspace(s);
      if (ws < 1) throw new Error('you are not a developer of any workspace yet: ask an administrator to add you to one.');
      const doc = JSON.parse(req.body?.doc ?? '');
      const r = await owner.tx(async (c) => {
        const made = (await c.query('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), req.body?.alias?.trim() || null])).rows[0];
        await placeApp(c, made.id, ws);
        // (sprint 51) the Advisor on the imported application, before the commit: errors refuse it
        if (req.body?.check === 'true') {
          const errors = (await advise(made.id, c, { db: await workshopDb(s) })).findings.filter((f) => f.severity === 'error');
          if (errors.length)
            throw new Error(`the check found ${errors.length} error(s), nothing was imported: ${errors.slice(0, 5).map((f) =>
              `${f.entry ? `${f.entry.pageNo !== null ? `page ${f.entry.pageNo}, ` : ''}${f.entry.label}` : 'database'} (${f.field}): ${f.message}`).join('; ')}${errors.length > 5 ? '; …' : ''}. Fix them, or import without the check.`);
        }
        return made;
      });
      // supporting objects are never run on import: the developer reviews them and chooses
      const scripts = (await owner.one('select count(*)::int as n from meta.supporting_script where app_id = $1', [r.id])).n;
      flash(s, `Application imported. Check its database role and users under Settings / Shared Components.${scripts ? ` It has ${scripts} supporting object script(s): they were not run.` : ''}`);
      return back(reply, s, scripts ? `${BASE}/apps/${r.id}/supporting-objects?imported=1` : `${BASE}/apps/${r.id}`);
    } catch (e) {
      flash(s, `Import failed: ${(e as Error).message}`, 'error');
      return back(reply, s, `${BASE}/import`);
    }
  });

  // ---------------------------------------------------------------- app home


  app.get(`${BASE}/apps/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    rememberApp(s, a.id);
    const [pages, tables] = await Promise.all([
      owner.query(
        `select p.*, (select count(*) from meta.region r where r.page_id = p.id)::int as regions,
                (select count(*) from meta.item i where i.page_id = p.id)::int as items,
                (select count(*) from meta.dynamic_action d where d.page_id = p.id)::int as das,
                (select count(*) from meta.process x where x.page_id = p.id)::int as processes
           from meta.page p where p.app_id = $1 order by p.page_no`,
        [a.id],
      ),
      wizardTables(a.db_role),
    ]);
    const nextPage = Math.max(0, ...pages.rows.map((p) => p.page_no)) + 1;
    // (089) page groups: a column and a filter (?group=name, or "-" for pages without one)
    const groups = (await owner.query<{ name: string }>('select name from meta.page_group where app_id = $1 order by name', [a.id])).rows.map((g) => g.name);
    const grouped = groups.length > 0 || pages.rows.some((p) => p.page_group);
    const groupFilter = typeof req.query?.group === 'string' ? req.query.group : '';
    // (sprint 74) search by name or number, and a report or icon view (APEX: the application home)
    const q = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const icons = req.query?.view === 'icons';
    const shownPages = pages.rows.filter((p) => (!groupFilter || (groupFilter === '-' ? !p.page_group : p.page_group === groupFilter))
      && (!q || String(p.page_no) === q || String(p.name).toLowerCase().includes(q.toLowerCase())));
    const keep = (extra: Record<string, string>) => `?${new URLSearchParams({ ...(q ? { q } : {}), ...(groupFilter ? { group: groupFilter } : {}), ...extra })}`;
    const locks = new Map((await appLocks(a.id)).map((l) => [l.page_no, l]));
    const commentsPerPage = new Map((await owner.query('select page_no, count(*)::int as n from meta.dev_comment where app_id = $1 group by 1', [a.id])).rows.map((r) => [r.page_no, r.n]));
    const appLock = locks.get(0);
    const issues = await appIssues(a.id);
    const tx = tr(s);

    const main = html`
      ${appHeader(a, 'pages', s)}
      ${appLock && appLock.locked_by !== s.username ? html`<div class="alert alert-error" role="status">${icon('key')} ${lockText(appLock)} ${tx('app.lock_refused')}</div>` : ''}
      <div class="app-home">
      <div class="app-home-main">
      <div class="pages-bar">
        <form method="get" class="search u-mwnone" role="search">${groupFilter ? html`<input type="hidden" name="group" value="${groupFilter}">` : ''}${icons ? html`<input type="hidden" name="view" value="icons">` : ''}
          <label class="sr-only" for="f_pq">${tx('app.search_pages')}</label><input id="f_pq" name="q" type="search" value="${q}" placeholder="${tx('app.search_placeholder')}" data-filter-rows="pages-rows">
          <button class="btn">${icon('search')}<span class="sr-only">${tx('common.search')}</span></button></form>
        <div class="seg view-toggle" role="group" aria-label="${tx('ab.view')}">
          <a href="${keep({})}"${icons ? '' : raw(' aria-current="true"')}>${icon('list')} ${tx('ab.view_report')}</a><a href="${keep({ view: 'icons' })}"${icons ? raw(' aria-current="true"') : ''}>${icon('grid')} ${tx('app.view_icons')}</a></div>
        <a class="btn btn-hot" href="#create-page">${icon('plus')} ${tx('app.create_page')}</a>
      </div>
      ${region(tx('app.tab.pages'), html`${grouped
          ? html`<form method="get" class="search u-mwnone u-mb1"><div class="field"><label class="label" for="f_group">${tx('app.page_group')}</label>
              <select id="f_group" name="group">${[['', tx('app.all_pages')], ...groups.map((g) => [g, g]), ['-', tx('app.no_group')]].map(([v, l]) => html`<option value="${v}"${v === groupFilter ? raw(' selected') : ''}>${l}</option>`)}</select></div>
              <button class="btn u-selfend">${tx('common.show')}</button></form>`
          : ''}${icons
          ? html`<ul class="page-icons" id="pages-rows">${shownPages.map((p) => html`<li><a href="${designerUrl(a.id, p.page_no)}" class="page-icon"><span class="page-icon-no">${p.page_no}</span><b>${p.name}</b><small class="muted">${p.mode}, ${tx(p.regions === 1 ? 'app.regions_one' : 'app.regions', { n: p.regions })}</small></a></li>`)}</ul>`
          : html`<div class="table-wrap"><table class="report">
          <thead><tr><th class="num">${tx('app.col.page')}</th><th>${tx('ab.col.name')}</th>${grouped ? html`<th>${tx('app.col.group')}</th>` : ''}<th>${tx('app.col.mode')}</th><th class="num">${tx('app.col.regions')}</th><th class="num">${tx('app.col.items')}</th><th class="num">${tx('app.col.das')}</th><th class="num">${tx('app.col.processes')}</th><th>${tx('app.col.authz')}</th><th>${tx('app.col.protection')}</th><th>${tx('app.col.lock')}</th><th></th></tr></thead>
          <tbody id="pages-rows">${shownPages.map((p) => html`<tr>
            <td class="num">${p.page_no}</td><td><a href="${designerUrl(a.id, p.page_no)}">${p.name}</a>${commentsPerPage.get(p.page_no) ? html` <span class="tag" title="${tx('app.dev_comments')}">${tx(commentsPerPage.get(p.page_no) === 1 ? 'app.comments_one' : 'app.comments', { n: commentsPerPage.get(p.page_no) })}</span>` : ''}${issues.tag(p.page_no)}</td>${grouped ? html`<td>${p.page_group ?? '—'}</td>` : ''}<td>${p.mode}</td>
            <td class="num">${p.regions}</td><td class="num">${p.items}</td><td class="num">${p.das}</td><td class="num">${p.processes}</td>
            <td>${p.requires_auth ? (p.authz ?? '—') : tx('app.public')}</td><td>${p.protection}</td>
            <td>${((l) => (l ? html`<span class="lock-tag" title="${lockText(l)}">${icon('key')}<span>${l.locked_by === s.username ? tx('app.you') : l.locked_by}</span></span>` : '—'))(locks.get(p.page_no))}</td>
            <td><a href="/a/${a.alias}/${p.page_no}" target="_blank" rel="noopener">${tx('common.run')} ▸</a></td></tr>`)}</tbody>
        </table></div>`}${q && !shownPages.length ? html`<p class="muted">${tx('app.no_match', { q })}</p>` : ''}`)}
      <div id="app-lock">${region(tx('app.lock_region'), await lockPanel(s, a.id, 0, { headings: true }))}</div>
      <div class="columns" id="create-page">
        ${region(tx('app.from_table'), html`
          <p class="muted u-mt0">${tx('app.from_table_text')}</p>
          <form method="get" action="${BASE}/apps/${a.id}/wizard">
            <div class="form-grid">
              ${select('kind', tx('app.page_type'), 'report_form', WIZARD_KINDS.map(([k, label]): [string, string] => [k, label]))}
              ${select('table', tx('app.table_or_view'), '', tables.map((t): [string, string] => [t.t, t.access ? t.t : tx('app.no_access', { table: t.t, role: a.db_role })]))}
            </div>
            <div class="buttons"><button class="btn btn-hot">${tx('common.next')}</button></div>
          </form>
          <p><a href="${BASE}/apps/${a.id}/ai-pages">${tx('app.ai_pages')} ▸</a> <span class="muted">${tx('app.ai_pages_note')}</span></p>`)}
        ${region(tx('app.blank'), html`
          <form method="post" action="${BASE}/apps/${a.id}/pages">${csrf(s)}
            <div class="form-grid">
              ${input('page_no', tx('app.page_number'), nextPage, { type: 'number', required: true })}
              ${input('name', tx('ab.col.name'), '', { required: true })}
              ${select('mode', tx('app.col.mode'), 'normal', ['normal', 'modal'])}
              ${input('parent_page', tx('app.parent'), a.home_page, { type: 'number' })}
            </div>
            <div class="buttons"><button class="btn btn-hot">${tx('app.create_page')}</button></div>
          </form>`)}
      </div>
      </div>
      <aside class="app-tasks region region-standard" aria-labelledby="app-tasks-h"><header class="region-header"><h2 id="app-tasks-h">${tx('common.tasks')}</h2></header>
        <ul class="sc-links">
          <li><a href="/a/${a.alias}" target="_blank" rel="noopener">${icon('play')} ${tx('app.task.run')}</a></li>
          <li><a href="#create-page">${icon('plus')} ${tx('app.create_page')}</a></li>
          <li><a href="${BASE}/apps/${a.id}/ai-pages">${icon('lightbulb')} ${tx('app.ai_pages')}</a></li>
          <li><a href="${BASE}/apps/${a.id}/shared">${icon('layers')} ${tx('app.tab.shared')}</a></li>
          <li><a href="${BASE}/apps/${a.id}/shared?type=page_group">${icon('folder')} ${tx('app.task.page_groups')}</a></li>
          <li><a href="${BASE}/apps/${a.id}/export">${icon('download')} ${tx('app.head.export')}</a></li>
          <li><a href="${BASE}/apps/${a.id}/backups">${icon('history')} ${tx('app.head.backups')}</a></li>
          <li><a href="${BASE}/apps/${a.id}/supporting-objects">${icon('database')} ${tx('app.task.supporting')}</a></li>
          <li><a href="#app-lock">${icon('lock')} ${tx('app.task.lock')}</a></li>
          ${issues.task}
          <li><a href="${BASE}/apps/${a.id}/settings?tab=definition">${icon('trash')} ${tx('app.task.delete')}</a></li>
        </ul></aside>
      </div>`;
    return send(reply, s, shell(s, a.name, [['App Builder', BASE], [a.name]], main));
  });

  app.post(`${BASE}/apps/:id/pages`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const p = await owner.one(
        'insert into meta.page (app_id, page_no, name, title, mode, parent_page) values ($1, $2, $3, $3, $4, $5) returning id',
        [req.params.id, Number(b.page_no), b.name?.trim(), b.mode === 'modal' ? 'modal' : 'normal', b.parent_page ? Number(b.parent_page) : null],
      );
      flash(s, tr(s)('app.page_created'));
      return back(reply, s, `${BASE}/pages/${p.id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/apps/${req.params.id}`);
    }
  });

  // (0.31) the icon picker's search of the Lucide icons (src/icons.ts)
  app.get(`${BASE}/icons/search`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const q = String((req.query as Record<string, unknown>)?.q ?? '').slice(0, 60);
    return reply.header('cache-control', 'private, max-age=300').send({ icons: searchIcons(q), version: LUCIDE_VERSION });
  });

  app.get(`${BASE}/apps/:id/export`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const r = await owner.one('select meta.export_app($1) as doc', [a.alias]);
    // (sprint 106) the change log marks the change sets made before an application's latest export
    await logActivity({ appId: a.id, username: s.username, event: 'app_export', ip: clientIp(req), detail: String(req.query?.format ?? 'json') });
    // ?format=dir|text: one file per component, as `pgkiln export --format dir|text` writes it (docs/guide/18-cli.md)
    if (req.query?.format === 'dir' || req.query?.format === 'text')
      return reply
        .header('content-disposition', `attachment; filename="${a.alias}.pgkiln.zip"`)
        .type('application/zip')
        .send(Buffer.from(filesToZip(docToFiles(r.doc, req.query.format === 'text' ? 'text' : 'json'), a.alias)));
    return reply
      .header('content-disposition', `attachment; filename="${a.alias}.pgkiln.json"`)
      .type('application/json')
      .send(JSON.stringify(r.doc, null, 2));
  });

  // ---------------------------------------------------------------- settings
  /** (sprint 74) The tabs of an application's Settings. */
  const SETTINGS_TABS: [string, string][] = [
    ['definition', 'Definition'], ['security', 'Security'], ['signin', 'Sign-in'], ['ui', 'User Interface'],
    ['globalization', 'Globalization'], ['errors', 'Errors and Sessions'], ['pwa', 'Progressive Web App'],
  ];
  app.get(`${BASE}/apps/:id/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const providers = (await owner.query('select name, display_name, enabled from meta.auth_provider order by display_name')).rows;
    const directories = (await owner.query('select name, display_name, enabled from meta.ldap_directory order by display_name')).rows;
    const lists = (await owner.query('select name from meta.list where app_id = $1 order by name', [a.id])).rows.map((r) => r.name as string);
    const listChoices = (v: string | null, none: string): [string, string][] => [['', none], ...lists.map((n): [string, string] => [n, n]), ...(v && !lists.includes(v) ? [[v, tx('st.missing', { name: v })] as [string, string]] : [])];
    // (sprint 74) tabs like APEX's Edit Application Definition and Security Attributes: every tab of the
    // main form is in the page (the others hidden), so Save keeps all of them; without JavaScript the tabs are links
    const tab = SETTINGS_TABS.some(([k]) => k === req.query?.tab) ? String(req.query!.tab) : 'definition';
    const panel = (k: string) => raw(`<section class="settings-panel" data-tab="${k}"${k === tab ? '' : ' hidden'}>`);
    const end = raw('</section>');
    const authPart = (k: string) => raw(`<div class="auth-part" data-auth="${k}"${a.authentication === k ? '' : ' hidden'}>`);
    const main = html`${appHeader(a, 'settings', s)}
      <nav class="settings-tabs" aria-label="${tx('st.settings')}">${SETTINGS_TABS.map(([k, label]) => html`<a href="?tab=${k}" data-tab-link="${k}"${k === tab ? raw(' aria-current="page"') : ''}>${tx.dyn(`st.tab.${k}`, label)}</a>`)}</nav>
      <div class="settings-body">
        <form method="post" action="${BASE}/apps/${a.id}/settings" class="settings-form">${csrf(s)}<input type="hidden" name="tab" value="${tab}" data-settings-tab>
            ${panel('definition')}${region(tx('st.tab.definition'), html`
            <div class="form-grid">
              ${input('name', tx('st.name'), a.name, { required: true })}
              ${input('alias', tx('st.alias'), a.alias, { required: true })}
              ${input('version', tx('st.version'), a.version ?? '', { placeholder: tx('st.version_ph'), help: tx('st.version_help') })}
              ${input('home_page', tx('st.home_page'), a.home_page, { type: 'number' })}
              ${select('app_type', tx('st.app_type'), a.app_type ?? 'standard', APP_TYPES.map((t): [string, string] => [t, tx.dyn(`st.type.${t}`, APP_TYPE_LABELS[t])]),
                tx('st.app_type_help'))}
            </div>`)}${end}
            ${panel('security')}${region(tx('st.authentication'), html`
            <div class="form-grid">
              ${select('authentication', tx('st.authentication'), a.authentication, (['app_users', 'header', 'database', 'custom', 'none'] as const).map((k): [string, string] => [k, tx(`st.auth.${k}`)]))}
              ${input('db_role', tx('st.db_role'), a.db_role, { help: tx('st.db_role_help') })}
              <div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="debug" value="true"${a.debug ? raw(' checked') : ''}> ${tx('st.debug')}</label>
                <small class="help">${tx('st.debug_help')}</small></div>
              <div class="field"><span class="label">${tx('st.debug_msgs')}</span><span>${a.debug_level ? html`<b>${tx('st.debug_on', { level: a.debug_level })}</b>` : tx('st.off')} · <a href="${BASE}/apps/${a.id}/debug">${tx('st.debug_msgs')}</a></span>
                <small class="help">${tx.rich('st.debug_msgs_help', { fn: html`<code>meta.debug(level, text)</code>`, days: a.debug_retention_days })}</small></div>
            </div>
            ${authPart('header')}<h3>${tx('st.header_title')}</h3>
            <p class="muted">${tx.rich('st.header_intro', { env: html`<code>PGKILN_AUTH_HEADER_PROXIES</code>` })}${headerProxiesConfigured() ? '' : html` (<b>${tx('st.header_unset')}</b>)`}.</p>
            <div class="form-grid">
              ${input('header_name', tx('st.header_name'), a.header_name ?? '', { placeholder: DEFAULT_HEADER, help: tx('st.header_name_help') })}
              ${input('logout_url', tx('st.logout_url'), a.logout_url ?? '', { placeholder: tx('st.logout_url_ph'), help: tx('st.logout_url_help') })}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="header_auto_create" value="true"${a.header_auto_create ? raw(' checked') : ''}> ${tx('st.header_auto')}</label>
              <small class="help">${tx('st.header_auto_help')}</small></div>
            </div>${authPart('database')}<h3>${tx('st.db_title')}</h3>
            <p class="muted">${tx('st.db_intro')}</p>
            <div class="form-grid">
              ${input('db_auth_roles', tx('st.db_roles'), (a.db_auth_roles ?? []).join(', '), { placeholder: tx('st.db_roles_ph'), help: tx('st.db_roles_help') })}
              ${input('db_auth_member_of', tx('st.db_member'), a.db_auth_member_of ?? '', { placeholder: tx('st.db_member_ph'), help: tx('st.db_member_help') })}
            </div>
            </div>${authPart('custom')}<h3>${tx('st.custom_title')}</h3>
            <p class="muted">${tx('st.custom_intro')}</p>
            <div class="form-grid">
              ${input('custom_auth_function', tx('st.custom_fn'), a.custom_auth_function ?? '', { placeholder: tx('st.custom_fn_ph'), help: tx('st.custom_fn_help') })}
            </div>
            <div class="field" data-wide><label class="label" for="f_custom_auth_code">${tx('st.custom_body')}</label>
              <textarea id="f_custom_auth_code" name="custom_auth_code" class="code" rows="6" spellcheck="false" data-code="plpgsql">${a.custom_auth_code ?? ''}</textarea>
              <small class="help">${tx.rich('st.custom_body_help', { example: html`<code>return exists (select 1 from app.users where name = p_username and pw_hash = crypt(p_password, pw_hash));</code>` })}</small></div>
            <div class="field" data-wide><label class="label" for="f_custom_auth_post_code">${tx('st.custom_post')}</label>
              <textarea id="f_custom_auth_post_code" name="custom_auth_post_code" class="code" rows="4" spellcheck="false" data-code="plpgsql">${a.custom_auth_post_code ?? ''}</textarea>
              <small class="help">${tx('st.custom_post_help')}</small></div>
            </div>`)}${end}
            ${panel('signin')}${region(tx('st.signin'), html`
            <h3>${tx('st.methods')}</h3>
            <div class="field"><label class="check"><input type="checkbox" name="local_login" value="true"${a.local_login ? raw(' checked') : ''}> ${tx('st.local')}</label></div>
            ${directories.length
              ? directories.map((d) => html`<div class="field"><label class="check"><input type="checkbox" name="ldap_directories" value="${d.name}"${a.ldap_directories.includes(d.name) ? raw(' checked') : ''}> ${tx('st.ldap', { name: d.display_name })}${d.enabled ? '' : ` ${tx('st.disabled')}`}</label></div>`)
              : html`<p class="muted">${tx.rich('st.no_ldap', { add: html`<a href="${BASE}/users/directories">${tx('st.add_one')}</a>` })}</p>`}
            <small class="help">${tx('st.ldap_help')}</small>
            <div class="form-grid">${input('session_group', tx('st.session_group'), a.session_group ?? '', { placeholder: tx('st.session_group_ph'), help: tx('st.session_group_help') })}</div>
            ${await loginSettingsFields(a)}
            <div class="form-grid">${input('remember_me_days', tx('st.remember'), a.remember_me_days ?? '', { type: 'number', placeholder: tx('st.remember_ph'), help: tx('st.remember_help') })}</div>
            ${providers.length
              ? providers.map((pr) => html`<div class="field"><label class="check"><input type="checkbox" name="sso_providers" value="${pr.name}"${a.sso_providers.includes(pr.name) ? raw(' checked') : ''}> ${tx('st.sso', { name: pr.display_name })}${pr.enabled ? '' : ` ${tx('st.disabled')}`}</label></div>`)
              : html`<p class="muted">${tx.rich('st.no_sso', { add: html`<a href="${BASE}/users/providers">${tx('st.add_one')}</a>` })}</p>`}
            `)}${end}
            ${panel('ui')}${region(tx('st.tab.ui'), html`
            <h3>${tx('st.theme')}</h3>
            <div class="form-grid">
              ${select('base', tx('st.base'), baseStyleOf(a.theme), (['iris', 'lavender', 'standard'] as const).map((k): [string, string] => [k, tx(`st.base.${k}`)]), tx('st.base_help'))}
              ${input('accent', tx('st.accent'), a.theme?.accent ?? BASE_STYLES[baseStyleOf(a.theme)].accent, { type: 'color' })}
              ${input('header', tx('st.header_colour'), a.theme?.header ?? BASE_STYLES[baseStyleOf(a.theme)].header, { type: 'color' })}
              ${(['accent_dark', 'header_dark'] as const).map((k) => html`<div class="field"><label class="label" for="f_${k}">${tx(k === 'accent_dark' ? 'st.accent_dark' : 'st.header_dark')}</label>
                <input id="f_${k}" name="${k}" type="color" value="${a.theme?.[k] ?? (k === 'accent_dark' ? '#a59cff' : '#0d0c1a')}">
                <label class="check"><input type="checkbox" name="${k}_own" value="true"${a.theme?.[k] ? raw(' checked') : ''}> ${tx('st.own_colour')}</label></div>`)}
              ${select('nav', tx('st.nav'), a.theme?.nav ?? 'side', [['side', tx('st.nav.side')], ['top', tx('st.nav.top')]], tx('st.nav_help'))}
              ${select('nav_list', tx('st.nav_list'), a.nav_list ?? '', listChoices(a.nav_list, tx('st.nav_entries')), tx('st.nav_list_help'))}
              ${select('navbar_list', tx('st.navbar_list'), a.navbar_list ?? '', listChoices(a.navbar_list, tx('st.none_option')), tx('st.navbar_help'))}
              ${select('mode', tx('st.mode'), a.theme?.mode ?? 'auto', (['auto', 'light', 'dark'] as const).map((k): [string, string] => [k, tx(`st.mode.${k}`)]))}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="user_choice" value="true"${a.theme?.user_choice !== false ? raw(' checked') : ''}> ${tx('st.user_choice')}</label>
              <small class="help">${tx('st.user_choice_help')}</small></div>
            <p><a class="btn" href="${BASE}/apps/${a.id}/theme">${icon('settings')} ${tx('st.roller')}</a>
              <span class="muted">${(() => { const n = appStyles(a.theme).length; return n ? tx(n === 1 ? 'st.styles_one' : 'st.styles', { n }) : tx('st.no_styles'); })()}</span></p>
            `)}${end}
            ${panel('globalization')}${region(tx('st.tab.globalization'), html`
            <div class="form-grid">
              ${input('language', tx('st.language'), a.language, { help: tx('st.language_help') })}
              ${input('languages', tx('st.languages'), (a.languages ?? []).join(', '), { placeholder: tx('st.languages_ph'), help: tx('st.languages_help') })}
              ${select('language_from', tx('st.language_from'), a.language_from, (['browser', 'user', 'primary'] as const).map((k): [string, string] => [k, tx(`st.from.${k}`)]), tx('st.language_from_help'))}
              ${input('date_format', tx('st.date_format'), a.date_format, { placeholder: tx('st.date_format_ph'), help: tx('st.date_format_help') })}
              ${input('timestamp_format', tx('st.ts_format'), a.timestamp_format, { placeholder: tx('st.ts_format_ph') })}
            </div>
            ${await timeZoneSettings(a)}`)}${end}
            <div class="buttons settings-save"${['errors', 'pwa'].includes(tab) ? raw(' hidden') : ''}><button class="btn btn-hot">${tx('st.save_settings')}</button></div>
          </form>
          ${panel('definition')}<form method="post" action="${BASE}/apps/${a.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="${tx('st.delete_confirm', { app: a.name })}">${tx('st.delete')}</button>
          </form>${end}
        ${panel('errors')}${region(tx('st.tab.errors'), html`<form method="post" action="${BASE}/apps/${a.id}/settings/behaviour">${csrf(s)}
          <div class="form-grid">
            ${input('error_function', tx('st.error_fn'), a.error_function ?? '', { placeholder: tx('st.error_fn_ph'),
              help: tx('st.error_fn_help') })}
            ${input('session_warning_seconds', tx('st.warning'), a.session_warning_seconds ?? 120, { type: 'number',
              help: tx('st.warning_help') })}
          </div>
          <div class="buttons"><button class="btn">${tx('st.save')}</button></div></form>`)}${end}
        ${panel('pwa')}${region(tx('st.tab.pwa'), await pwaSection({ ...a, has_icon: !!(await owner.one('select pwa_icon is not null as h from meta.app where id = $1', [a.id]))?.h }, s))}${end}
        ${panel('security')}${region(tx('st.checklist'), html`<ul class="checklist">
          <li>${a.db_role ? '✓' : '✗'} ${tx('st.ck.role')} ${a.db_role ? html`(<code>${a.db_role}</code>)` : html`<b>${tx('st.ck.runtime')}</b>`}</li>
          <li>${a.authentication !== 'none' ? '✓' : '•'} ${a.authentication !== 'none' ? tx('st.ck.signin') : tx('st.ck.public')}</li>
          ${a.authentication === 'header' ? html`<li>${headerProxiesConfigured() ? '✓' : '✗'} Sign-in: HTTP header <code>${a.header_name || DEFAULT_HEADER}</code> ${headerProxiesConfigured() ? 'from the proxies in PGKILN_AUTH_HEADER_PROXIES' : html`<b>refused: PGKILN_AUTH_HEADER_PROXIES is not set</b>`}; access: ${a.access_control === 'any_user' ? 'any active account' : 'listed accounts only'}${a.header_auto_create ? ', new accounts created automatically' : ''}</li>` : ''}
          ${a.authentication === 'database' ? html`<li>${a.db_auth_roles?.length || a.db_auth_member_of ? '✓' : '✗'} Sign-in: database accounts (${[a.db_auth_roles?.length ? `roles ${a.db_auth_roles.join(', ')}` : '', a.db_auth_member_of ? `members of ${a.db_auth_member_of}` : ''].filter(Boolean).join('; ') || html`<b>no roles allowed</b>`})</li>` : ''}
          ${a.authentication === 'custom' ? html`<li>${a.custom_auth_function || a.custom_auth_code ? '✓' : '✗'} Sign-in: custom ${a.custom_auth_function ? html`function <code>${a.custom_auth_function}</code>` : a.custom_auth_code ? 'function body' : html`<b>no check configured: nobody can sign in</b>`}${a.custom_auth_post_code ? ', with post-authentication code' : ''}</li>` : ''}
          ${a.authentication === 'app_users' ? html`<li>Sign-in: ${[a.local_login ? 'password' : '', ...a.ldap_directories.map((d: string) => `LDAP ${d}`), ...a.sso_providers].filter(Boolean).join(', ') || html`<b>no method enabled</b>`}; access: ${a.access_control === 'any_user' ? 'any active account' : 'listed accounts only'}</li>` : ''}
          <li>${a.debug ? `✗ ${tx('st.ck.debug_on')}` : `✓ ${tx('st.ck.debug_off')}`}</li>
          <li>${a.debug_level ? `✗ ${tx('st.ck.msgs_on', { level: a.debug_level })}` : `✓ ${tx('st.ck.msgs_off')}`}</li>
          <li>${tx('st.ck.unprotected', { n: (await owner.one("select count(*)::int as n from meta.page where app_id = $1 and protection = 'unrestricted'", [a.id])).n })}</li>
          <li>${tx('st.ck.public_pages', { n: (await owner.one('select count(*)::int as n from meta.page where app_id = $1 and not requires_auth', [a.id])).n })}</li>
        </ul>`)}${end}
      </div>`;
    return send(reply, s, shell(s, tx('st.title', { app: a.name }), [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Settings']], main));
  });

  // (085) error handling function and session timeout warning
  app.post(`${BASE}/apps/:id/settings/behaviour`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const fn = String(b.error_function ?? '').trim();
    const seconds = Number(b.session_warning_seconds ?? 120);
    try {
      if (fn && !/^[A-Za-z_][A-Za-z0-9_$]{0,62}\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(fn)) throw new Error(tr(s)('st.err.fn_shape'));
      if (fn && !(await owner.one(`select 1 as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                    where n.nspname = $1 and p.proname = $2 and p.pronargs = 1 and p.proargtypes[0] = 'jsonb'::regtype and p.prorettype = 'jsonb'::regtype`, fn.split('.'))))
        throw new Error(tr(s)('st.err.no_fn', { fn }));
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) throw new Error(tr(s)('st.err.warning'));
      await owner.query('update meta.app set error_function = $2, session_warning_seconds = $3, updated_at = now() where id = $1', [req.params.id, fn || null, seconds]);
      flash(s, tr(s)('st.saved'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/settings?tab=errors`);
  });

  app.post(`${BASE}/apps/:id/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      await owner.query(
        `update meta.app set name = $2, alias = $3, home_page = $4, authentication = $5, db_role = $6, debug = $7,
                -- (053) the Theme Roller's styles stay: only the keys of this form are replaced
                theme = (theme - 'accent' - 'header' - 'nav' - 'mode' - 'user_choice' - 'base' - 'accent_dark' - 'header_dark') || $8::jsonb,
                local_login = $9, sso_providers = $10, language = $11, languages = $12, language_from = $13,
                date_format = $14, timestamp_format = $15, remember_me_days = $16, ldap_directories = $17,
                header_name = $18, header_auto_create = $19, logout_url = $20, db_auth_roles = $21, db_auth_member_of = $22,
                custom_auth_function = $23, custom_auth_code = $24, custom_auth_post_code = $25, nav_list = $26, navbar_list = $27,
                app_type = $28, session_group = $29, version = $30, updated_at = now() where id = $1`,
        [req.params.id, b.name?.trim(), b.alias?.trim().toLowerCase(), Number(b.home_page) || 1, b.authentication, b.db_role?.trim() || null, b.debug === 'true',
         JSON.stringify({
           base: baseStyleOf({ base: b.base }) === 'standard' ? undefined : baseStyleOf({ base: b.base }),
           accent_dark: b.accent_dark_own === 'true' && /^#[0-9a-f]{6}$/i.test(b.accent_dark ?? '') ? b.accent_dark!.toLowerCase() : undefined,
           header_dark: b.header_dark_own === 'true' && /^#[0-9a-f]{6}$/i.test(b.header_dark ?? '') ? b.header_dark!.toLowerCase() : undefined,
           // a colour equal to a base style's own is not stored, so changing the base style changes it too
           accent: /^#[0-9a-f]{6}$/i.test(b.accent ?? '') && !Object.values(BASE_STYLES).some((x) => x.accent === b.accent!.toLowerCase()) ? b.accent : undefined,
           header: /^#[0-9a-f]{6}$/i.test(b.header ?? '') && !Object.values(BASE_STYLES).some((x) => x.header === b.header!.toLowerCase()) ? b.header : undefined,
           nav: b.nav === 'top' ? 'top' : 'side',
           mode: ['light', 'dark'].includes(b.mode ?? '') ? b.mode : 'auto',
           user_choice: b.user_choice === 'true',
         }),
         b.local_login === 'true',
         ([] as string[]).concat((b.sso_providers as unknown as string | string[] | undefined) ?? []).filter(Boolean),
         b.language?.trim().toLowerCase() || 'en',
         [...new Set((b.languages ?? '').split(',').map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(l) && l !== (b.language?.trim().toLowerCase() || 'en')))],
         ['primary', 'user'].includes(b.language_from ?? '') ? b.language_from : 'browser',
         b.date_format?.trim() || null,
         b.timestamp_format?.trim() || null,
         Number.isInteger(Number(b.remember_me_days)) && Number(b.remember_me_days) >= 1 && Number(b.remember_me_days) <= 365 ? Number(b.remember_me_days) : null,
         ([] as string[]).concat((b.ldap_directories as unknown as string | string[] | undefined) ?? []).filter(Boolean),
         b.header_name?.trim() || null,
         b.header_auto_create === 'true',
         b.logout_url?.trim() || null,
         ((roles) => (roles.length ? roles : null))(parseRoleList(b.db_auth_roles)),
         validRoleName(b.db_auth_member_of),
         b.custom_auth_function?.trim() || null,
         b.custom_auth_code?.trim() || null,
         b.custom_auth_post_code?.trim() || null,
         b.nav_list?.trim().toUpperCase() || null,
         b.navbar_list?.trim().toUpperCase() || null,
         (APP_TYPES as readonly string[]).includes(b.app_type ?? '') ? b.app_type : 'standard',
         /^[a-z][a-z0-9_]{0,29}$/.test(b.session_group?.trim().toLowerCase() ?? '') ? b.session_group!.trim().toLowerCase() : null,
         (b.version ?? '').trim().slice(0, 40) || null],
      );
      await saveTimeZoneSettings(req.params.id, b);
      await saveLoginSettings(req.params.id, b);
      flash(s, tr(s)('st.settings_saved'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    // (sprint 74) back to the tab the form was saved from
    const tab = /^[a-z]{1,20}$/.test(String(b.tab ?? '')) ? `?tab=${b.tab}` : '';
    return back(reply, s, `${BASE}/apps/${req.params.id}/settings${tab}`);
  });

  app.post(`${BASE}/apps/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.app where id = $1', [req.params.id]);
    flash(s, tr(s)('st.app_deleted'));
    return back(reply, s, BASE);
  });

  // ---------------------------------------------------------------- activity
  app.get(`${BASE}/apps/:id/activity`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const [stats, byPage, events] = await Promise.all([
      owner.one(
        `select count(*) filter (where event = 'page_view')::int as views,
                count(distinct username) filter (where event = 'page_view')::int as users,
                coalesce(round(avg(elapsed_ms) filter (where event = 'page_view')), 0)::int as avg_ms,
                count(*) filter (where event in ('login_failed', 'login_locked'))::int as failures,
                count(*) filter (where event in ('forbidden', 'error'))::int as problems
           from meta.activity_log where app_id = $1 and at > now() - interval '1 day'`,
        [a.id],
      ),
      owner.query(
        `select l.page_no, p.name, count(*)::int as views, round(avg(elapsed_ms))::int as avg_ms, max(elapsed_ms) as max_ms
           from meta.activity_log l left join meta.page p on p.app_id = l.app_id and p.page_no = l.page_no
          where l.app_id = $1 and l.event = 'page_view' and l.at > now() - interval '7 days'
          group by 1, 2 order by 3 desc`,
        [a.id],
      ),
      owner.query(
        `select id, at, event, username, page_no, ip, elapsed_ms, detail from meta.activity_log
          where app_id = $1 and (event <> 'page_view' or $2) order by id desc limit 100`,
        [a.id, req.query.all === '1'],
      ),
    ]);
    const main = html`${appHeader(a, 'activity', s)}
      <div class="stat-grid">
        <div class="stat"><b>${stats.views}</b><span>page views (24h)</span></div>
        <div class="stat"><b>${stats.users}</b><span>distinct users (24h)</span></div>
        <div class="stat"><b>${stats.avg_ms} ms</b><span>average page time</span></div>
        <div class="stat"><b>${stats.failures}</b><span>failed / locked sign-ins (24h)</span></div>
        <div class="stat"><b>${stats.problems}</b><span>errors / access denied (24h)</span></div>
      </div>
      <div class="columns">
        <p><a class="btn" href="${BASE}/apps/${a.id}/top-sql">${icon('database')} Top SQL</a> <span class="muted">the slowest statements of this application's database role</span></p>
        <p><a class="btn" href="${BASE}/apps/${a.id}/ai">${icon('bolt')} AI usage</a> <span class="muted">the AI services this application may use, and its requests</span></p>
        <p><a class="btn" href="${BASE}/apps/${a.id}/feedback">${icon('chat')} Feedback</a> <span class="muted">what users sent from the application's Feedback link, and your answers</span></p>
        <p><a class="btn" href="${BASE}/apps/${a.id}/mail">${icon('send')} Mail</a> <span class="muted">the mail this application queued and sent, with retry and cancel</span></p>
        <p><a class="btn" href="${BASE}/apps/${a.id}/debug">${icon('list')} Debug messages</a> <span class="muted">${a.debug_level ? `on (level ${a.debug_level}): ` : 'off: '}timed steps of each request and messages from <code>meta.debug()</code></span></p>
        ${region('Page views by page (7 days)', html`<div class="table-wrap"><table class="report"><thead><tr><th class="num">Page</th><th>Name</th><th class="num">Views</th><th class="num">Avg ms</th><th class="num">Max ms</th></tr></thead>
          <tbody>${byPage.rows.map((r) => html`<tr><td class="num">${r.page_no}</td><td>${r.name}</td><td class="num">${r.views}</td><td class="num">${r.avg_ms}</td><td class="num">${r.max_ms}</td></tr>`)}</tbody></table></div>`)}
        ${region('Recent events', html`<p class="muted u-mt0">${req.query.all === '1' ? html`Showing all events. <a href="?">Hide page views</a>` : html`Sign-ins, denials and errors. <a href="?all=1">Include page views</a>`}</p>
          <div class="table-wrap"><table class="report"><thead><tr><th>When</th><th>Event</th><th>User</th><th class="num">Page</th><th>IP</th><th>Detail</th></tr></thead>
          <tbody>${events.rows.map((r) => html`<tr><td>${String(r.at).slice(0, 19)}</td><td><span class="ev ev-${r.event}">${r.event}</span></td><td>${r.username}</td><td class="num">${r.page_no}</td><td>${r.ip}</td><td title="${r.detail}">${r.detail}</td></tr>`)}</tbody></table></div>`)}
      </div>`;
    return send(reply, s, shell(s, 'Activity', [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Activity']], main));
  });

  // ---------------------------------------------------------------- developers
  app.get(`${BASE}/developers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const devs = (await owner.query(`select username, is_admin, email, break_glass, exists (select 1 from meta.developer_factor f where f.username = d.username) as mfa,
                                            (select string_agg(coalesce(p.display_name, l.display_name), ', ' order by 1) from meta.developer_identity i
                                               left join meta.auth_provider p on p.id = i.provider_id left join meta.ldap_directory l on l.id = i.directory_id
                                              where i.username = d.username) as identities
                                       from meta.developer d order by 1`)).rows;
    const admin = devs.some((d) => d.username === s.username && d.is_admin);
    const me = devs.find((d) => d.username === s.username);
    const tx = tr(s);
    const main = html`<h1 class="u-mb1">${tx('dev.title')}</h1>
      <div class="columns">
        ${region(tx('dev.change_pw'), html`<form method="post" action="${BASE}/developers/password">${csrf(s)}
          <div class="form-grid">
            ${input('current', tx('dev.current'), '', { type: 'password', required: true, auto: 'current-password' })}
            ${input('password', tx('dev.new'), '', { type: 'password', required: true, auto: 'new-password', help: tx('dev.min8') })}
          </div>
          <div class="buttons"><button class="btn btn-hot">${tx('dev.change_btn')}</button></div></form>`)}
        ${region(tx('dev.your_email'), html`<form method="post" action="${BASE}/developers/email">${csrf(s)}<input type="hidden" name="username" value="${s.username}">
          <div class="form-grid">${input('email', tx('dev.email'), me?.email ?? '', { type: 'email', auto: 'email', help: tx('dev.email_help') })}</div>
          <div class="buttons"><button class="btn">${tx('dev.save')}</button></div></form>`)}
        ${region(tx('dev.accounts'), html`
          <p class="muted u-mt0">${tx('dev.accounts_help')}</p>
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('dev.username')}</th><th>${tx('dev.role')}</th><th>${tx('dev.email_col')}</th><th>${tx('mfa.column')}</th><th></th></tr></thead><tbody>
            ${devs.map((d) => html`<tr><td data-label="${tx('dev.username')}">${d.username}${d.username === s.username ? ` ${tx('dev.you')}` : ''}</td><td data-label="${tx('dev.role')}">${d.is_admin ? tx('dev.administrator') : tx('dev.developer')}${d.break_glass ? html` <span class="badge badge-warn" title="${tx('bsso.break_glass_help')}">${tx('bsso.break_glass')}</span>` : ''}${d.identities ? html`<br><span class="muted small">${icon('log-in')} ${d.identities}</span>` : ''}</td>
              <td data-label="${tx('dev.email_col')}">${admin && d.username !== s.username
                ? html`<form method="post" action="${BASE}/developers/email" class="search u-m0 u-mwnone">${csrf(s)}<input type="hidden" name="username" value="${d.username}"><input name="email" type="email" value="${d.email ?? ''}" aria-label="${tx('dev.email_of', { user: d.username })}" placeholder="${tx('dev.none')}"><button class="btn">${tx('dev.save')}</button></form>`
                : html`<span class="wrap-anywhere">${d.email ?? ''}</span>`}</td>
              <td data-label="${tx('mfa.column')}">${d.mfa ? html`${icon('lock')} ${tx('mfa.on')}${admin && d.username !== s.username ? html` <details class="menu u-inline"><summary class="link-button">${tx('mfa.reset')}</summary><div class="menu-panel"><form method="post" action="${BASE}/developers/reset-2fa" class="menu-section">${csrf(s)}<input type="hidden" name="username" value="${d.username}">
                  ${input(`reason_${d.username}`.replace(/[^\w]/g, '_'), tx('mfa.reason'), '', { required: true, help: tx('mfa.reset_help', { user: d.username }) })}
                  <button class="btn btn-sm btn-danger">${tx('mfa.reset_btn')}</button></form></div></details>` : ''}` : html`<span class="muted">${tx('mfa.off')}</span>`}</td><td>${d.username === s.username || !admin ? '' : html`
              <form method="post" action="${BASE}/developers/admin" class="u-inline">${csrf(s)}<input type="hidden" name="username" value="${d.username}"><input type="hidden" name="is_admin" value="${d.is_admin ? 'false' : 'true'}"><button class="link-button">${d.is_admin ? tx('dev.make_dev') : tx('dev.make_admin')}</button></form>
              ${d.is_admin ? html`· <form method="post" action="${BASE}/developers/break-glass" class="u-inline">${csrf(s)}<input type="hidden" name="username" value="${d.username}"><input type="hidden" name="break_glass" value="${d.break_glass ? 'false' : 'true'}"><button class="link-button" title="${tx('bsso.break_glass_help')}">${d.break_glass ? tx('bsso.break_glass_remove') : tx('bsso.break_glass_make')}</button></form>` : ''}
              · <form method="post" action="${BASE}/developers/delete" class="u-inline">${csrf(s)}<input type="hidden" name="username" value="${d.username}"><button class="link-button" data-confirm="${tx('dev.remove_confirm', { user: d.username })}">${tx('dev.remove')}</button></form>`}</td></tr>`)}
          </tbody></table></div>
          ${admin
            ? html`<h3>${tx('dev.add')}</h3>
              <form method="post" action="${BASE}/developers">${csrf(s)}
                <div class="form-grid">${input('username', tx('dev.username'), '', { required: true })}${input('password', tx('dev.password'), '', { type: 'password', required: true, auto: 'new-password' })}${input('email', tx('dev.email'), '', { type: 'email', help: tx('dev.optional_email') })}</div>
                <div class="field"><label class="check"><input type="checkbox" name="is_admin" value="true"> ${tx('dev.administrator')}</label></div>
                <div class="buttons"><button class="btn btn-hot">${tx('dev.add')}</button></div>
              </form>`
            : html`<p class="muted">${tx('dev.admins_only')}</p>`}`)}
      </div>`;
    return send(reply, s, shell(s, tx('dev.title'), [['Developers']], main, 'developers'));
  });

  app.post(`${BASE}/developers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators add developers.');
    try {
      const problem = await passwordProblem(req.body?.password);
      if (problem) throw new Error(problem);
      const ws = currentWorkspace(s);
      await owner.tx(async (c) => {
        const email = String(req.body?.email ?? '').trim();
        if (email && !EMAIL.test(email)) throw new Error(tr(s)('dev.err.email'));
        await c.query('insert into meta.developer (username, password_hash, is_admin, email) values ($1, meta.hash_password($2), $3, $4)', [req.body?.username?.trim(), req.body?.password, req.body?.is_admin === 'true', email || null]);
        // (064) a new developer works in the current workspace; more on Workspace utilities → Workspaces
        // (the insert trigger put them in Default)
        if (ws > 0 && ws !== 1) {
          await c.query('delete from meta.workspace_member where workspace_id = 1 and username = $1', [req.body?.username?.trim()]);
          await c.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [ws, req.body?.username?.trim()]);
        }
      });
      flash(s, ws > 0 ? tr(s)('dev.added_ws', { name: s.workspace!.name }) : tr(s)('dev.added'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/developers`);
  });

  app.post(`${BASE}/developers/password`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    try {
      const problem = await passwordProblem(req.body?.password);
      if (problem) throw new Error(problem);
      const r = await owner.query(
        `update meta.developer set password_hash = meta.hash_password($3)
          where username = $1 and password_hash = crypt($2, password_hash)`,
        [s.username, req.body?.current ?? '', req.body?.password],
      );
      if (r.rowCount !== 1) throw new Error(tr(s)('dev.err.current'));
      // End all other builder sessions of this developer, and (sprint 127) forget the browsers they trusted.
      await owner.query('delete from meta.session where app_id is null and username = $1 and id <> $2', [s.username, s.id]);
      await forgetBrowsers(s.username!);
      delete s.state.__WEAK;
      flash(s, tr(s)('dev.pw_changed'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/developers`);
  });

  // (096) a developer's own e-mail address; administrators set anyone's
  app.post(`${BASE}/developers/email`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const who = String(req.body?.username ?? s.username);
    if (who !== s.username && !(await isAdmin(s.username))) return reply.code(403).send('Only administrators change other developers\' addresses.');
    const email = String(req.body?.email ?? '').trim();
    if (email && (!EMAIL.test(email) || email.length > 254)) flash(s, tr(s)('dev.err.email'), 'error');
    else {
      const r = await owner.query('update meta.developer set email = $2 where username = $1', [who, email || null]);
      flash(s, tr(s)(r.rowCount ? 'dev.email_saved' : 'dev.not_found'), r.rowCount ? 'ok' : 'error');
    }
    return back(reply, s, `${BASE}/developers`);
  });

  app.post(`${BASE}/developers/admin`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators change roles.');
    if (req.body?.username && req.body.username !== s.username) {
      if (req.body.is_admin !== 'true' && (await leavesTooFewAdmins(req.body.username))) {
        flash(s, tr(s)('mfa.keep_admins'), 'error');
        return back(reply, s, `${BASE}/developers`);
      }
      // (sprint 129) break-glass is for administrators: a developer loses it, unless they are the last one needed
      if (req.body.is_admin !== 'true' && (await leavesNoBreakGlass(req.body.username))) {
        flash(s, tr(s)('bsso.keep_break_glass'), 'error');
        return back(reply, s, `${BASE}/developers`);
      }
      await owner.query('update meta.developer set is_admin = $2, break_glass = break_glass and $2 where username = $1', [req.body.username, req.body.is_admin === 'true']);
      flash(s, tr(s)('dev.role_changed'));
    }
    return back(reply, s, `${BASE}/developers`);
  });

  app.post(`${BASE}/developers/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators remove developers.');
    if (req.body?.username && req.body.username !== s.username) {
      if ((await leavesTooFewAdmins(req.body.username)) || (await leavesNoBreakGlass(req.body.username))) {
        flash(s, tr(s)('mfa.keep_admins'), 'error');
        return back(reply, s, `${BASE}/developers`);
      }
      await owner.query('delete from meta.developer where username = $1', [req.body.username]);
      await owner.query('delete from meta.session where app_id is null and username = $1', [req.body.username]);
      flash(s, tr(s)('dev.removed'));
    }
    return back(reply, s, `${BASE}/developers`);
  });
}
