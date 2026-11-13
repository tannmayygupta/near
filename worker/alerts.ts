// Operator alerts. A sink (Telegram) behind an interface, with: a three-state send result, a timeout, secrets never in logs,
// and de-duplication that ignores the digits in a message ("3 stuck" and "4 stuck" are the same condition) so a persistent problem is told once per hour.
export type SendResult = 'sent' | 'retry' | 'refused';
export interface AlertSink { send(text: string): Promise<SendResult> }
export type AlertOutcome = SendResult | 'deduped' | 'disabled';

/** Telegram Bot API sink. The URL contains the bot token, so error handling logs only the kind and the HTTP status. */
export class TelegramSink implements AlertSink {
  constructor(private token: string, private chatId: string, private f: typeof fetch = fetch, private log: (k: string, f: Record<string, unknown>) => void = () => {}) {}
  async send(text: string): Promise<SendResult> {
    try {
      const r = await this.f(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 3900), disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return 'sent';
      this.log('alert_send_failed', { status: r.status });
      return r.status === 429 || r.status >= 500 ? 'retry' : 'refused'; // 4xx other than 429: bad token/chat, retrying will not help
    } catch (e) {
      this.log('alert_send_failed', { kind: (e as Error).name }); // never the message: it may contain the URL
      return 'retry';
    }
  }
}

export class Alerts {
  private seen = new Map<string, number>();
  constructor(private sink: AlertSink | null, private o: { now?: () => number; dedupeMs?: number; log?: (k: string, f: Record<string, unknown>) => void } = {}) {}
  private get now() { return this.o.now?.() ?? Date.now(); }
  static fingerprint(text: string) { return text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase(); }
  async admin(text: string): Promise<AlertOutcome> {
    if (!this.sink) { this.o.log?.('alert_disabled', { text: text.slice(0, 200) }); return 'disabled'; }
    const fp = Alerts.fingerprint(text); const now = this.now; const last = this.seen.get(fp);
    if (last !== undefined && now - last < (this.o.dedupeMs ?? 3_600_000)) return 'deduped';
    this.seen.set(fp, now);
    const r = await this.sink.send(text);
    if (r === 'retry') this.seen.delete(fp); // a failed send must be tried again next time
    return r;
  }
}
