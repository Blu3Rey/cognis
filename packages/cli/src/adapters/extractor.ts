/**
 * Real content extraction.
 *
 * Mozilla's Readability over a linkedom DOM: the same algorithm Firefox
 * Reader View uses, which is what the mobile client's WebView would run.
 * linkedom rather than jsdom because it is an order of magnitude lighter and
 * Readability does not need a full browser environment.
 *
 * This is the first place cognis meets a real document, and it is where the
 * long tail lives — paywalls, JS-only pages, boilerplate, syndication. A
 * failure here is a first-class outcome (docs/03 § Extraction): the source and
 * the ingestion event survive it.
 */

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export const EXTRACTOR_NAME = 'readability+linkedom';
export const EXTRACTOR_VERSION = '1.0.0';

export interface ExtractedDocument {
  title: string | null;
  byline: string | null;
  /** Plain text, chrome removed. What goes into document_version. */
  text: string;
  /** The publisher's own canonical URL, when it declares one. Outranks the requested URL. */
  canonicalUrl: string | null;
  lang: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  siteName: string | null;
  wordCount: number;
}

export class ExtractionError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/**
 * The slice of the DOM this module uses.
 *
 * Declared structurally rather than by pulling in the DOM lib, which would
 * also assert that `window` and several hundred browser APIs exist in Node.
 * linkedom's document satisfies this shape.
 */
interface MinimalElement {
  getAttribute(name: string): string | null;
}
interface MinimalDocument {
  querySelector(selectors: string): MinimalElement | null;
  documentElement: MinimalElement | null;
}

/** Collapse Readability's output into tidy paragraphs the chunker can read. */
function normaliseText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function meta(document: MinimalDocument, names: string[]): string | null {
  for (const name of names) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ??
      document.querySelector(`meta[name="${name}"]`);
    const content = el?.getAttribute('content')?.trim();
    if (content) return content;
  }
  return null;
}

/**
 * Minimum words before we believe a fetched page is an article rather than a
 * consent wall or a JS shell.
 *
 * This guards against the web, not against the user. A local file someone
 * deliberately pointed at may legitimately be three sentences long, so
 * `extractHtml` takes the floor as an option and the file path lowers it.
 */
export const MIN_ARTICLE_WORDS = 50;

export interface ExtractOptions {
  /** Override the short-document floor. */
  minWords?: number;
}

export function extractHtml(
  html: string,
  url: string,
  opts: ExtractOptions = {},
): ExtractedDocument {
  const { document } = parseHTML(html);

  // Read these before Readability mutates the document: it strips the head.
  const doc = document as unknown as MinimalDocument;
  const canonicalUrl =
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim() ??
    meta(doc, ['og:url']) ??
    null;
  const lang = doc.documentElement?.getAttribute('lang')?.slice(0, 5) ?? null;
  const publishedAt = meta(doc, [
    'article:published_time', 'datePublished', 'publish_date', 'date',
  ]);
  const siteName = meta(doc, ['og:site_name']);

  let parsed: ReturnType<Readability['parse']>;
  try {
    parsed = new Readability(document as never, { charThreshold: 200 }).parse();
  } catch (err) {
    throw new ExtractionError(
      `readability failed: ${err instanceof Error ? err.message : String(err)}`,
      'readability_error',
    );
  }

  if (!parsed?.textContent?.trim()) {
    throw new ExtractionError(
      'no article content found (JS-rendered page, paywall, or not an article)',
      'no_content',
    );
  }

  const text = normaliseText(parsed.textContent);
  const wordCount = countWords(text);

  const minWords = opts.minWords ?? MIN_ARTICLE_WORDS;
  if (wordCount < minWords) {
    // Better to record a clean failure than to store a cookie banner as an
    // article. A silent junk extraction is counted as a defect in docs/12 §1.
    throw new ExtractionError(
      `only ${wordCount} words extracted; likely a paywall, consent wall or stub`,
      'too_short',
    );
  }

  return {
    title: parsed.title?.trim() || null,
    byline: parsed.byline?.trim() || null,
    text,
    canonicalUrl: canonicalUrl ? resolveUrl(canonicalUrl, url) : null,
    lang: parsed.lang ?? lang,
    publishedAt: normaliseDate(publishedAt ?? parsed.publishedTime ?? null),
    excerpt: parsed.excerpt?.trim() || null,
    siteName: parsed.siteName?.trim() || siteName,
    wordCount,
  };
}

/** Plain text and markdown need no extraction, only tidying. */
export function extractPlainText(raw: string): ExtractedDocument {
  const text = normaliseText(raw);
  const wordCount = countWords(text);
  if (wordCount === 0) throw new ExtractionError('file is empty', 'no_content');

  // A markdown H1, or the first non-empty line, is the best title available.
  const firstLine = text.split('\n').find((l) => l.trim()) ?? null;
  const title = firstLine
    ? firstLine.replace(/^#+\s*/, '').slice(0, 200)
    : null;

  return {
    title,
    byline: null,
    text,
    canonicalUrl: null,
    lang: null,
    publishedAt: null,
    excerpt: null,
    siteName: null,
    wordCount,
  };
}

function resolveUrl(candidate: string, base: string): string | null {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}

function normaliseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
