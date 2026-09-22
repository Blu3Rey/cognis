/**
 * `cognis ingest` — the whole point of the CLI.
 *
 * Capture is attested and happens first, so a source the user encountered is
 * recorded even when extraction then fails on a paywall (docs/03). Everything
 * after that is derived and can be re-run.
 */

import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { textFingerprint } from '@cognis/core';
import type { Cognis } from '@cognis/core';
import { fetchDocument, FetchError } from '../adapters/fetcher.js';
import {
  extractHtml, extractPlainText, ExtractionError,
  EXTRACTOR_NAME, EXTRACTOR_VERSION,
} from '../adapters/extractor.js';
import type { ExtractedDocument } from '../adapters/extractor.js';

export interface IngestResult {
  sourceId: string;
  ingestionEventId: string;
  url: string | null;
  title: string | null;
  wordCount: number;
  reEncounter: boolean;
  isPrivate: boolean;
  privateReason: string | null;
  extracted: boolean;
  failureReason: string | null;
  indexed: boolean;
  chunks: number;
  novelty: number | null;
  noveltyComparable: boolean;
  priorEvents: number;
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text']);
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);

function isUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

export interface IngestOptions {
  /** Skip chunking and embedding; capture and extract only. */
  noIndex?: boolean;
  /** Force the source private regardless of classification. */
  private?: boolean;
  capturePath?: 'share_sheet' | 'reader' | 'file_import' | 'backfill';
  /** Override the short-document floor. Local files default to 1. */
  minWords?: number;
}

export async function ingestOne(
  cognis: Cognis,
  target: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  let extracted: ExtractedDocument | null = null;
  let failureReason: string | null = null;
  let finalUrl: string | null = null;

  // --- Fetch or read -------------------------------------------------------
  if (isUrl(target)) {
    try {
      const fetched = await fetchDocument(target);
      finalUrl = fetched.finalUrl;
      const mime = fetched.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
      extracted = mime.startsWith('text/plain') || mime === 'text/markdown'
        ? extractPlainText(fetched.body)
        : extractHtml(fetched.body, fetched.finalUrl, {
            ...(opts.minWords === undefined ? {} : { minWords: opts.minWords }),
          });
    } catch (err) {
      if (err instanceof FetchError || err instanceof ExtractionError) {
        failureReason = err instanceof ExtractionError
          ? `${err.reason}: ${err.message}`
          : err.message;
      } else {
        throw err;
      }
    }
  } else {
    const ext = extname(target).toLowerCase();
    const raw = await readFile(target, 'utf8');
    try {
      // A local file is something the user deliberately pointed at, so the
      // consent-wall floor does not apply: a three-sentence note is a valid
      // document, not a failed extraction.
      extracted = HTML_EXTENSIONS.has(ext)
        ? extractHtml(raw, `file://${target}`, { minWords: opts.minWords ?? 1 })
        : TEXT_EXTENSIONS.has(ext) || ext === ''
          ? extractPlainText(raw)
          : extractPlainText(raw);
    } catch (err) {
      if (err instanceof ExtractionError) failureReason = `${err.reason}: ${err.message}`;
      else throw err;
    }
  }

  // --- Capture (attested, happens whatever extraction did) -----------------
  const capturePath = opts.capturePath ?? (isUrl(target) ? 'share_sheet' : 'file_import');
  const capture = await cognis.capture({
    kind: isUrl(target) ? 'url' : 'text',
    payload: isUrl(target) ? target : `file://${target}`,
    capturePath,
    ...(extracted?.title ? { title: extracted.title } : {}),
    ...(extracted?.byline ? { authors: [extracted.byline] } : {}),
    ...(extracted?.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
    ...(extracted?.canonicalUrl ? { relCanonical: extracted.canonicalUrl } : {}),
    ...(finalUrl ? { resolvedUrl: finalUrl } : {}),
    ...(opts.private ? { isPrivate: true } : {}),
  });

  const result: IngestResult = {
    sourceId: capture.sourceId,
    ingestionEventId: capture.ingestionEventId,
    url: finalUrl ?? (isUrl(target) ? target : null),
    title: extracted?.title ?? basename(target),
    wordCount: extracted?.wordCount ?? 0,
    reEncounter: capture.reEncounter,
    isPrivate: capture.isPrivate,
    privateReason: capture.privateReason,
    extracted: extracted !== null,
    failureReason,
    indexed: false,
    chunks: 0,
    novelty: null,
    noveltyComparable: false,
    priorEvents: capture.priorCoverage.previousEvents.length,
  };

  if (!extracted) {
    await cognis.recordExtractionFailure(
      capture.ingestionEventId,
      failureReason ?? 'unknown extraction failure',
    );
    return result;
  }

  // --- Store the extracted text -------------------------------------------
  const dv = await cognis.recordExtraction({
    sourceId: capture.sourceId,
    ingestionEventId: capture.ingestionEventId,
    text: extracted.text,
    textHash: await textFingerprint(extracted.text),
    lang: extracted.lang,
    producer: EXTRACTOR_NAME,
    producerVersion: EXTRACTOR_VERSION,
  });

  if (opts.noIndex || !cognis.embedder) return result;

  // --- Chunk, embed, score novelty ----------------------------------------
  const indexed = await cognis.indexDocument({
    documentVersionId: dv.documentVersionId,
    ingestionEventId: capture.ingestionEventId,
  });

  result.indexed = true;
  result.chunks = indexed.indexed.chunksCreated;
  result.novelty = indexed.novelty.comparable ? indexed.novelty.novelty : null;
  result.noveltyComparable = indexed.novelty.comparable;
  return result;
}
