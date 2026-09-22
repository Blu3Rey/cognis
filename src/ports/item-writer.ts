/**
 * Item writer port — quiz item generation.
 *
 * Generated questions are derived and disposable. They may point at, select
 * from, structure, or question corpus content; they may never become corpus
 * content (docs/08-llm-integration.md § The generation boundary).
 */

export interface EvidenceSpan {
  sourceId: string;
  documentVersionId: string;
  chunkId: string;
  startChar: number;
  endChar: number;
  text: string;
  sourceTitle: string | null;
}

export interface ItemGenerationRequest {
  conceptId: string;
  conceptLabel: string;
  /**
   * Spans mentioning the concept, across sources. More than one source is what
   * makes a `synthesis` item possible, and synthesis items are the type no
   * other product can generate.
   */
  evidence: EvidenceSpan[];
  /** Item kinds the caller wants. */
  kinds: readonly ('free_recall' | 'cloze' | 'application' | 'synthesis')[];
  maxItems: number;
}

export interface RubricPoint {
  id: string;
  /** What a correct answer must convey. */
  text: string;
  /** Where in the corpus this point is supported. Validated before storage. */
  citation: {
    documentVersionId: string;
    startChar: number;
    endChar: number;
  };
}

export interface GeneratedItem {
  kind: 'free_recall' | 'cloze' | 'application' | 'synthesis';
  prompt: string;
  expectedPoints: RubricPoint[];
  evidence: EvidenceSpan[];
  difficultyHint?: number;
}

export interface ItemWriter {
  readonly modelId: string;
  readonly promptVersion: string;
  generate(req: ItemGenerationRequest): Promise<GeneratedItem[]>;
}
