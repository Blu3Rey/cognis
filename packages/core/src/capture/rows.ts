/** Row <-> domain mapping. Kept in one place so column names live in one file. */

import type {
  Source, IngestionEvent, DocumentVersion, SourceKind, CapturePath,
  Engagement, EngagementSource, IngestionStatus,
} from '../types.js';

export interface SourceRow {
  id: string;
  kind: string;
  canonical_url: string | null;
  doi: string | null;
  isbn: string | null;
  content_hash: string | null;
  title: string | null;
  authors_json: string | null;
  published_at: string | null;
  first_seen_at: string;
  is_private: number;
}

export function toSource(r: SourceRow): Source {
  return {
    id: r.id,
    kind: r.kind as SourceKind,
    canonicalUrl: r.canonical_url,
    doi: r.doi,
    isbn: r.isbn,
    contentHash: r.content_hash,
    title: r.title,
    authors: r.authors_json ? (JSON.parse(r.authors_json) as string[]) : null,
    publishedAt: r.published_at,
    firstSeenAt: r.first_seen_at,
    isPrivate: r.is_private === 1,
  };
}

export interface IngestionEventRow {
  id: string;
  source_id: string;
  occurred_at: string;
  capture_path: string;
  engagement: string | null;
  engagement_source: string | null;
  novelty: number | null;
  novelty_model_id: string | null;
  status: string;
  status_reason: string | null;
}

export function toIngestionEvent(r: IngestionEventRow): IngestionEvent {
  return {
    id: r.id,
    sourceId: r.source_id,
    occurredAt: r.occurred_at,
    capturePath: r.capture_path as CapturePath,
    engagement: r.engagement as Engagement | null,
    engagementSource: r.engagement_source as EngagementSource | null,
    novelty: r.novelty,
    noveltyModelId: r.novelty_model_id,
    status: r.status as IngestionStatus,
    statusReason: r.status_reason,
  };
}

export interface DocumentVersionRow {
  id: string;
  source_id: string;
  text: string;
  text_hash: string;
  word_count: number;
  lang: string | null;
  extracted_at: string;
  producer: string;
  producer_version: string;
}

export function toDocumentVersion(r: DocumentVersionRow): DocumentVersion {
  return {
    id: r.id,
    sourceId: r.source_id,
    text: r.text,
    textHash: r.text_hash,
    wordCount: r.word_count,
    lang: r.lang,
    extractedAt: r.extracted_at,
    producer: r.producer,
    producerVersion: r.producer_version,
  };
}
