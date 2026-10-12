// Mock mail providers for the tests (no real mail is sent): an HTTP server
// that answers like Microsoft Entra (token), Microsoft Graph, Amazon SES,
// Resend, Postmark, SendGrid and Mailgun, and a small SMTP server with
// AUTH PLAIN and XOAUTH2. Both record what they received.
import { createServer as httpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as tcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface HttpHit {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export interface SmtpHit {
  auth: string | null;
  from: string;
  to: string[];
  data: string;
}

export const TOKEN = 'mock-access-token';

export class MailMock {
  http!: Server;
  smtp!: TcpServer;
  httpHits: HttpHit[] = [];
  smtpHits: SmtpHit[] = [];
  /** answer the next HTTP sends with this status (then 200/202 again) */
  failWith: number[] = [];
  /** SMTP: recipients refused with 550 (permanent) or 451 (temporary) */
  smtpReject = new Map<string, 550 | 451>();
  httpUrl = '';
  smtpPort = 0;

  async start() {
    this.http = httpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const path = req.url ?? '';
        this.httpHits.push({ method: req.method ?? '', path, headers: req.headers, body });
        const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { 'content-type': 'application/json', ...headers });
          res.end(json === null ? '' : JSON.stringify(json));
        };
        if (path.endsWith('/token')) {
          const form = new URLSearchParams(body.toString());
          if (form.get('client_secret') !== 'the-client-secret') return send(401, { error: 'invalid_client', error_description: 'bad secret' });
          return send(200, { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 });
        }
        const fail = this.failWith.shift();
        if (fail) return send(fail, { message: `mock failure ${fail}` });
        if (path.includes('/sendMail')) return req.headers.authorization === `Bearer ${TOKEN}` ? send(202, null) : send(401, { error: { message: 'no token' } });
        if (path === '/v2/email/outbound-emails') return send(200, { MessageId: 'ses-1' });
        if (path === '/emails') return send(200, { id: 'resend-1' });
        if (path === '/email') return send(200, { MessageID: 'postmark-1', ErrorCode: 0 });
        if (path === '/v3/mail/send') return send(202, null, { 'x-message-id': 'sendgrid-1' });
        if (/^\/v3\/[^/]+\/messages$/.test(path)) return send(200, { id: '<mailgun-1@example.com>', message: 'Queued' });
        return send(404, { message: 'unknown path' });
      });
    });
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', r));
    this.httpUrl = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;

    this.smtp = tcpServer((socket) => this.session(socket));
    await new Promise<void>((r) => this.smtp.listen(0, '127.0.0.1', r));
    this.smtpPort = (this.smtp.address() as AddressInfo).port;
  }

  private session(socket: Socket) {
    let buffer = '';
    let inData = false;
    let hit: SmtpHit = { auth: null, from: '', to: [], data: '' };
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 mock ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          hit.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          this.smtpHits.push(hit);
          hit = { auth: hit.auth, from: '', to: [], data: '' };
          say('250 2.0.0 OK queued as mock-1');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const [verb, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO':
            socket.write('250-mock\r\n250-AUTH PLAIN XOAUTH2\r\n250 SIZE 52428800\r\n');
            break;
          case 'HELO':
            say('250 mock');
            break;
          case 'AUTH': {
            const [mech, data] = arg.split(' ');
            const decoded = Buffer.from(data ?? '', 'base64').toString();
            if (mech === 'PLAIN' && decoded === '\0mailer@example.com\0the-password') hit.auth = 'plain';
            else if (mech === 'XOAUTH2' && decoded === `user=mailer@example.com\x01auth=Bearer ${TOKEN}\x01\x01`) hit.auth = 'xoauth2';
            else {
              say('535 5.7.8 Authentication failed');
              break;
            }
            say('235 2.7.0 Authenticated');
            break;
          }
          case 'MAIL':
            hit.from = /<([^>]*)>/.exec(arg)?.[1] ?? '';
            say('250 OK');
            break;
          case 'RCPT': {
            const to = /<([^>]*)>/.exec(arg)?.[1] ?? '';
            const reject = this.smtpReject.get(to);
            if (reject) say(`${reject} ${reject === 550 ? '5.1.1 no such user' : '4.3.0 try again later'}`);
            else {
              hit.to.push(to);
              say('250 OK');
            }
            break;
          }
          case 'DATA':
            inData = true;
            say('354 go ahead');
            break;
          case 'RSET':
            hit = { auth: hit.auth, from: '', to: [], data: '' };
            say('250 OK');
            break;
          case 'NOOP':
            say('250 OK');
            break;
          case 'QUIT':
            say('221 bye');
            socket.end();
            return;
          default:
            say('502 not implemented');
        }
      }
    });
    socket.on('error', () => {});
  }

  reset() {
    this.httpHits = [];
    this.smtpHits = [];
    this.failWith = [];
    this.smtpReject.clear();
  }

  async stop() {
    await new Promise((r) => this.http.close(r));
    await new Promise((r) => this.smtp.close(r));
  }
}
