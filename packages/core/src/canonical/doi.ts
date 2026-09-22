/**
 * DOI normalisation.
 *
 * A DOI outranks any URL as source identity: it collapses the publisher page,
 * the PDF, the arXiv preprint and every mirror into one source. This is the
 * single highest-value dedup rule in the system, which is why research papers
 * get a privileged ingestion path (docs/03-ingestion.md).
 */

/**
 * DOIs are `10.<registrant>/<suffix>`. The suffix is deliberately permissive
 * in the spec, so this pattern is tolerant and relies on the prefix for
 * confidence.
 */
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9<>+\[\]]+)/i;

/** Trailing characters that are almost always sentence punctuation, not DOI. */
const TRAILING_JUNK = /[.,;:)\]>'"]+$/;

/**
 * Normalise a DOI or a string containing one.
 *
 * Accepts bare DOIs, `doi:` prefixes, and resolver URLs (doi.org,
 * dx.doi.org). Returns lowercase — the ASCII portion of a DOI is
 * case-insensitive, and lowercasing makes the unique index do its job.
 *
 * Returns null when no DOI is present, rather than throwing: most sources
 * legitimately have none.
 */
export function normaliseDoi(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;

  // Strip resolver prefixes.
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:\s*/i, '');
  s = s.replace(/^info:doi\//i, '');

  const m = DOI_RE.exec(s);
  if (!m?.[1]) return null;

  const doi = m[1].replace(TRAILING_JUNK, '');
  // A DOI that lost its whole suffix to junk-stripping is not a DOI.
  if (!/\/.+/.test(doi)) return null;
  return doi.toLowerCase();
}

/** The canonical resolver URL for a DOI, for display and fetching. */
export function doiUrl(doi: string): string {
  return `https://doi.org/${doi}`;
}

/** Extract a DOI from free text (a page body, a PDF's first page). */
export function findDoiInText(text: string): string | null {
  return normaliseDoi(text);
}

/**
 * arXiv ids are not DOIs but identify the same work, and modern arXiv papers
 * have a registered DOI of a predictable shape.
 */
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/i;

export function arxivIdFromUrl(url: string): string | null {
  const m = ARXIV_RE.exec(url);
  return m?.[1] ?? null;
}

export function arxivDoi(arxivId: string): string {
  return `10.48550/arxiv.${arxivId}`;
}
