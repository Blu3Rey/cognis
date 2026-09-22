/**
 * Redaction before egress.
 *
 * docs/09 § rule 4: strip credentials and session tokens from URLs, and remove
 * obvious PII patterns from chunk text, recording what was stripped.
 *
 * Best-effort and documented as such. Pattern-based redaction cannot catch
 * everything, which is exactly why it is the fourth rule and not the first —
 * the private flag and the domain denylist do the real work, and this reduces
 * incidental leakage in content that was already cleared for egress.
 */

export interface Redaction {
  kind: string;
  count: number;
}

export interface RedactionResult<T> {
  value: T;
  redactions: Redaction[];
}

const PATTERNS: readonly { kind: string; re: RegExp; replacement: string }[] = [
  { kind: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, replacement: '[email]' },
  {
    kind: 'bearer_token',
    re: /\b(?:bearer|token|api[_-]?key|secret)\s*[:=]\s*\S+/gi,
    replacement: '[token]',
  },
  {
    kind: 'long_hex',
    re: /\b[0-9a-f]{32,}\b/gi,
    replacement: '[hex]',
  },
  {
    kind: 'jwt',
    re: /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g,
    replacement: '[jwt]',
  },
  {
    kind: 'card_number',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    replacement: '[card]',
  },
];

/** Query parameters that carry session state and must never be transmitted. */
const CREDENTIAL_PARAMS = [
  'token', 'access_token', 'id_token', 'refresh_token', 'auth', 'session',
  'sessionid', 'sid', 'key', 'api_key', 'apikey', 'password', 'pwd', 'secret',
  'signature', 'sig',
];

export function redactUrl(url: string): RedactionResult<string> {
  const redactions: Redaction[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { value: url, redactions };
  }

  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    redactions.push({ kind: 'url_userinfo', count: 1 });
  }

  let stripped = 0;
  for (const name of [...parsed.searchParams.keys()]) {
    if (CREDENTIAL_PARAMS.includes(name.toLowerCase())) {
      parsed.searchParams.delete(name);
      stripped++;
    }
  }
  if (stripped > 0) redactions.push({ kind: 'url_credential_param', count: stripped });

  return { value: parsed.toString(), redactions };
}

export function redactText(text: string): RedactionResult<string> {
  const redactions: Redaction[] = [];
  let out = text;

  for (const { kind, re, replacement } of PATTERNS) {
    let count = 0;
    out = out.replace(re, (match) => {
      // A card-number pattern also matches long runs of ordinary digits, so
      // require a Luhn check before treating it as a card.
      if (kind === 'card_number' && !passesLuhn(match)) return match;
      count++;
      return replacement;
    });
    if (count > 0) redactions.push({ kind, count });
  }

  return { value: out, redactions };
}

function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
