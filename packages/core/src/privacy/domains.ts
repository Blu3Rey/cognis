/**
 * Domain classification for the private-by-default rule.
 *
 * docs/09-privacy-and-security.md § rule 3: banking, health portals, webmail,
 * internal corporate hosts and anything behind an authenticated session that
 * looks transactional are auto-marked private. The default posture for an
 * unrecognised authenticated page is private, not public.
 *
 * This is a heuristic and is documented as one. It is a floor, not a
 * guarantee: the user can mark anything private, and nothing here can be
 * relied on to catch every sensitive host.
 */

/** Host suffixes whose content never leaves the device by default. */
const SENSITIVE_SUFFIXES: readonly string[] = [
  // Webmail and messaging
  'mail.google.com', 'outlook.com', 'outlook.office.com', 'mail.yahoo.com',
  'proton.me', 'protonmail.com', 'fastmail.com', 'zoho.com',
  // Banking and payments
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com',
  'paypal.com', 'stripe.com', 'wise.com', 'revolut.com', 'coinbase.com',
  // Health
  'mychart.com', 'myhealth.va.gov', 'healthcare.gov', 'nhs.uk',
  'labcorp.com', 'questdiagnostics.com',
  // Government and identity
  'irs.gov', 'ssa.gov', 'gov.uk/account', 'id.me',
];

/** Host *labels* that mark a service host regardless of domain. */
const SENSITIVE_LABELS: readonly string[] = [
  'mail', 'webmail', 'banking', 'bank', 'secure', 'portal', 'patient',
  'billing', 'payroll', 'admin', 'intranet', 'vpn', 'sso', 'auth', 'login',
  'account', 'accounts', 'wallet', 'health', 'medical', 'ehr',
];

/** Hosts that are structurally internal and never public. */
function isInternalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    return true;
  }
  // No dot at all: a bare intranet hostname.
  if (!host.includes('.')) return true;
  // Literal IP addresses.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

/** Path fragments that indicate an authenticated, transactional page. */
const SENSITIVE_PATHS: readonly string[] = [
  '/account', '/accounts', '/billing', '/invoice', '/statement',
  '/settings/security', '/checkout', '/payment', '/transfer',
  '/patient', '/records', '/payroll', '/admin',
];

export interface PrivacyClassification {
  isPrivate: boolean;
  /** Which rule fired, so a surprising classification is explainable. */
  reason: string | null;
}

/**
 * Classify a URL.
 *
 * Returns not-private for anything unparseable rather than throwing: a capture
 * must never fail because classification could not run, and the caller already
 * validates URLs.
 */
export function classifyUrl(url: string): PrivacyClassification {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { isPrivate: false, reason: null };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (isInternalHost(host)) {
    return { isPrivate: true, reason: `internal or unqualified host: ${host}` };
  }

  for (const suffix of SENSITIVE_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`) || `${host}${path}`.startsWith(suffix)) {
      return { isPrivate: true, reason: `known sensitive service: ${suffix}` };
    }
  }

  const labels = host.split('.');
  for (const label of labels.slice(0, -2)) {
    if (SENSITIVE_LABELS.includes(label)) {
      return { isPrivate: true, reason: `service subdomain: ${label}` };
    }
  }

  for (const p of SENSITIVE_PATHS) {
    if (path === p || path.startsWith(`${p}/`)) {
      return { isPrivate: true, reason: `transactional path: ${p}` };
    }
  }

  // Credentials in the URL mean an authenticated context by construction.
  if (parsed.username || parsed.password) {
    return { isPrivate: true, reason: 'URL carries credentials' };
  }

  return { isPrivate: false, reason: null };
}
