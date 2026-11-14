// Secret scrubbing for text that leaves the worker through a PUBLIC endpoint (red-team results, /attestation details).
// Two layers: (1) the exact secret values this process was started with, (2) shapes that are only ever secrets (NEAR secret keys, bearer tokens, API keys).
// Public identifiers (account ids, tx hashes, public keys, 64-hex wallet addresses) are deliberately left alone: they are the evidence.
const SHAPES: Array<[RegExp, string]> = [
  [/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, 'ed25519:[redacted]'],      // 88-char base58 = a secret key (public keys are 44 chars)
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],                      // NEAR AI Cloud inference key
  [/\b(?:wk|api)_[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],             // OutLayer wallet key, NEAR Builders key
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[redacted-bot-token]'],        // Telegram bot token
];

/** Build a redactor that removes the given secret values (ignored when shorter than 8 characters) and the secret-shaped strings above. */
export function makeRedactor(secrets: Array<string | undefined> = []): (text: string) => string {
  const exact = [...new Set(secrets.filter((s): s is string => typeof s === 'string' && s.trim().length >= 8).map((s) => s.trim()))].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = String(text);
    for (const s of exact) out = out.split(s).join('[redacted]');
    for (const [re, to] of SHAPES) out = out.replace(re, to);
    return out;
  };
}

/** The environment variables whose VALUES must never appear in a public response. */
export const SECRET_ENV = [
  'AGENT_SECRET_KEY', 'CUSTODY_OWNER_KEY', 'CUSTODY_SEED', 'VAULT_SECRET_KEY', 'NEAR_AI_API_KEY', 'OUTLAYER_WK', 'SEALED_TERMS_KEY',
  'LAYER_A_OWNER_KEY', 'LAYER_A_SEED', 'SOCIAL_ACCOUNT_KEY', 'ALERT_TELEGRAM_TOKEN',
] as const;

/** Redactor over the secrets present in this process's environment. */
export const envRedactor = (env: Record<string, string | undefined> = process.env) => makeRedactor(SECRET_ENV.map((k) => env[k]));
