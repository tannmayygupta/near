// Tests the alert sink against TELEGRAM'S REAL API.
//   npx tsx scripts/dev/alert-test.ts              -> no credentials: sends with a deliberately invalid token and asserts Telegram's real answer is classified `refused`
//                                                     (proves the HTTP path, the timeout handling and that the token never reaches the log)
//   ALERT_TELEGRAM_TOKEN=... ALERT_TELEGRAM_CHAT=... npx tsx scripts/dev/alert-test.ts   -> also delivers a real test message (create a bot with @BotFather, send it a message, use /chatid)
import { Alerts, TelegramSink } from '../../worker/alerts.js';

const logs: string[] = []; const log = (k: string, f: Record<string, unknown>) => logs.push(`${k} ${JSON.stringify(f)}`);
const BAD = '123456:INVALID-TOKEN-FOR-TESTING';
let failed = 0; const check = (n: string, ok: boolean, note = '') => { if (!ok) failed++; console.log(ok ? 'PASS' : 'FAIL', n, note); };

const refused = await new TelegramSink(BAD, '1', fetch, log).send('Quiet Treasury alert test (invalid token)');
check('Telegram answers an invalid token with a 4xx that the sink classifies as `refused` (not retried forever)', refused === 'refused', `result=${refused}; log=${logs.join(' | ')}`);
check('the bot token never appears in a log line', !logs.join('\n').includes(BAD) && !logs.join('\n').includes('INVALID-TOKEN'));
const a = new Alerts(new TelegramSink(BAD, '1', fetch, log), { log });
check('a refused alert is remembered, so a broken token does not hammer the API', (await a.admin('probe 1')) === 'refused' && (await a.admin('probe 2')) === 'deduped');

const token = process.env.ALERT_TELEGRAM_TOKEN, chat = process.env.ALERT_TELEGRAM_CHAT;
if (token && chat) {
  const r = await new Alerts(new TelegramSink(token, chat, fetch, log), { log }).admin(`Quiet Treasury alert test ${new Date().toISOString()}: if you can read this, delivery works.`);
  check('a real message was delivered to the configured chat', r === 'sent', `result=${r}`);
} else console.log('SKIP  live delivery: set ALERT_TELEGRAM_TOKEN and ALERT_TELEGRAM_CHAT to test it');
process.exit(failed ? 1 : 0);
