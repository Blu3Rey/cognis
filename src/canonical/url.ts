/**
 * URL canonicalisation.
 *
 * Purpose is dedup identity, not display: two URLs that denote the same
 * article must produce the same canonical form, so that re-encountering a
 * source attaches a second ingestion event rather than creating a second
 * source. See docs/03-ingestion.md § Deduplication and identity.
 *
 * This module is pure. Redirect-chain resolution and rel=canonical extraction
 * need the network and the document, so they are the caller's job — the
 * results are fed back in through `CanonicaliseOptions`.
 */

/** Exact tracking parameter names to drop. */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'yclid', 'igshid',
  'mc_cid', 'mc_eid', 'ml_subscriber', 'ml_subscriber_hash',
  'vero_id', 'vero_conv', 'oly_enc_id', 'oly_anon_id',
  '_ga', '_gl', '_hsenc', '_hsmi', 'hsctatracking',
  'ref_src', 'ref_url', 'spm', 'scm', 'share_id',
  'wt_zmc', 'icid', 'cmpid', 'campaign_id',
]);

/** Prefixes whose entire family is tracking. */
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_', 'piwik_', 'matomo_', 'hsa_'];

/**
 * Host-specific parameters that look like tracking but are load-bearing, and
 * host-specific parameters that look meaningful but are not.
 *
 * `si` is a share-tracking token on YouTube and Spotify; `v` is the video id on
 * YouTube and must survive. Getting this wrong in either direction is a dedup
 * bug, so the exceptions are explicit rather than heuristic.
 */
const HOST_DROP: Record<string, readonly string[]> = {
  'youtube.com': ['si', 'pp', 'feature', 'ab_channel'],
  'youtu.be': ['si', 'feature'],
  'open.spotify.com': ['si', 'nd', 'context'],
  'twitter.com': ['s', 't'],
  'x.com': ['s', 't'],
  'amazon.com': ['ref', 'psc', 'th', 'tag'],
  'medium.com': ['source', 'sk'],
};

/** Hosts where the `www.` prefix is not meaningful. */
function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

export interface CanonicaliseOptions {
  /**
   * The document's own rel=canonical URL, if the extractor found one. It wins
   * over the requested URL, because the publisher is authoritative about which
   * URL denotes the article.
   */
  relCanonical?: string | undefined;
  /**
   * The final URL after following redirects, if the fetcher resolved them.
   * Applied before any other rule.
   */
  resolvedUrl?: string | undefined;
  /**
   * Keep the fragment. Off by default — fragments are usually in-page anchors
   * that do not change document identity. PDF page anchors are the exception
   * a caller may want to preserve.
   */
  keepFragment?: boolean | undefined;
}

export interface CanonicalUrl {
  /** The canonical form, used as the dedup key. */
  url: string;
  /** Host after normalisation, for per-host policy. */
  host: string;
  /** Parameters removed, for debugging a surprising dedup result. */
  droppedParams: string[];
}

function isTrackingParam(host: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  if (TRACKING_PREFIXES.some((p) => lower.startsWith(p))) return true;
  const hostDrops = HOST_DROP[host];
  if (hostDrops?.includes(lower)) return true;
  return false;
}

/**
 * Canonicalise a URL for dedup.
 *
 * Throws on input that is not a parseable absolute http(s) URL — callers
 * should treat that as a capture validation failure, not silently store junk.
 */
export function canonicaliseUrl(
  input: string,
  opts: CanonicaliseOptions = {},
): CanonicalUrl {
  const raw = (opts.relCanonical ?? opts.resolvedUrl ?? input).trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TypeError(`not an absolute URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new TypeError(`unsupported URL scheme: ${u.protocol}`);
  }

  // Scheme and host normalisation. http -> https is deliberate: the same
  // article served over both must not become two sources.
  u.protocol = 'https:';
  u.hostname = stripWww(u.hostname.toLowerCase());
  if (u.port === '80' || u.port === '443') u.port = '';

  const host = u.hostname;

  // Query: drop tracking, keep the rest, sort for stable output.
  const dropped: string[] = [];
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (isTrackingParam(host, k)) dropped.push(k);
    else kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Path: collapse duplicate slashes, drop a single trailing slash (but keep
  // the root's), and decode needlessly-escaped characters.
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  u.pathname = path;

  if (!opts.keepFragment) u.hash = '';

  return { url: u.toString(), host, droppedParams: dropped };
}

/** True when two URLs denote the same document after canonicalisation. */
export function sameDocument(a: string, b: string): boolean {
  try {
    return canonicaliseUrl(a).url === canonicaliseUrl(b).url;
  } catch {
    return false;
  }
}
