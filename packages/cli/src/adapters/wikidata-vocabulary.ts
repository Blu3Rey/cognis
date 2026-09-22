/**
 * Wikidata as the concept vocabulary.
 *
 * This is the adapter that makes ADR-0005 real: concept identity comes from a
 * stable public identifier, so re-running extraction with a different model
 * changes the evidence and never the node. The fixture vocabulary in core has
 * eight concepts; Wikidata has on the order of 100 million, with the candidate
 * ambiguity that implies — which is the whole reason the linker's precision
 * has to be measured rather than assumed.
 *
 * No model is involved here. This is a lookup, and keeping it that way is what
 * turns linking from open-ended naming into a bounded classification task.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  VocabularyClient, ConceptCandidate, VocabularyEdge, VocabularyHierarchy,
} from '@cognis/core';

const API = 'https://www.wikidata.org/w/api.php';

/** Wikimedia asks for a descriptive agent with contact information. */
export const WIKIDATA_USER_AGENT =
  'cognis/0.0.1 (personal knowledge manager; +https://github.com/Blu3Rey/cognis)';

/** `subclass of` and `instance of` — the hierarchy the taxonomy view renders. */
const P_SUBCLASS_OF = 'P279';
const P_INSTANCE_OF = 'P31';

export type JsonFetcher = (url: string) => Promise<unknown>;

export interface WikidataOptions {
  /** Directory for the on-disk response cache. Omit to disable caching. */
  cacheDir?: string;
  language?: string;
  /** Minimum gap between requests, in ms. Politeness, not performance. */
  minIntervalMs?: number;
  /** Injected in tests. */
  fetchJson?: JsonFetcher;
}

interface SearchResponse {
  search?: {
    id: string;
    label?: string;
    description?: string;
    aliases?: string[];
    match?: { type: string; text: string };
  }[];
}

interface EntitiesResponse {
  entities?: Record<string, {
    id: string;
    labels?: Record<string, { value: string }>;
    descriptions?: Record<string, { value: string }>;
    aliases?: Record<string, { value: string }[]>;
    claims?: Record<string, {
      mainsnak?: { datavalue?: { value?: { id?: string } } };
    }[]>;
  }>;
}

/** Wikidata ids are bare Qxxx on the wire; cognis prefixes them by scheme. */
export function toConceptId(qid: string): string {
  return `wd:${qid}`;
}

export function toQid(conceptId: string): string | null {
  return conceptId.startsWith('wd:') ? conceptId.slice(3) : null;
}

export class WikidataVocabulary implements VocabularyClient {
  readonly #language: string;
  readonly #cacheDir: string | null;
  readonly #minIntervalMs: number;
  readonly #fetchJson: JsonFetcher;
  #lastRequestAt = 0;
  #inFlight: Promise<unknown> = Promise.resolve();

  constructor(opts: WikidataOptions = {}) {
    this.#language = opts.language ?? 'en';
    this.#cacheDir = opts.cacheDir ?? null;
    this.#minIntervalMs = opts.minIntervalMs ?? 120;
    this.#fetchJson = opts.fetchJson ?? defaultFetchJson;
  }

  async #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.#cacheDir) return load();

    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    const path = join(this.#cacheDir, `${hash}.json`);
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      // Cache miss or unreadable entry: fetch and repopulate.
    }

    const value = await load();
    try {
      await mkdir(this.#cacheDir, { recursive: true });
      await writeFile(path, JSON.stringify(value), 'utf8');
    } catch {
      // A cache that cannot be written is a performance problem, not a
      // correctness one. Never fail a lookup over it.
    }
    return value;
  }

  /**
   * Serialise requests with a minimum gap.
   *
   * Candidate generation fires once per surface form per chunk, which is
   * thousands of lookups over a real corpus. Hammering a free public API for
   * a personal tool is not acceptable, and the on-disk cache means the cost is
   * paid once.
   */
  async #polite<T>(load: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.#minIntervalMs - (Date.now() - this.#lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.#lastRequestAt = Date.now();
      return load();
    };
    const chained = this.#inFlight.then(run, run);
    this.#inFlight = chained.then(() => undefined, () => undefined);
    return chained;
  }

  async search(surfaceForm: string, limit: number): Promise<ConceptCandidate[]> {
    const term = surfaceForm.trim();
    if (!term) return [];

    const url =
      `${API}?action=wbsearchentities&format=json&origin=*` +
      `&search=${encodeURIComponent(term)}` +
      `&language=${this.#language}&uselang=${this.#language}` +
      `&limit=${Math.min(Math.max(limit, 1), 50)}&type=item`;

    const body = await this.#cached(url, () =>
      this.#polite(() => this.#fetchJson(url)),
    ) as SearchResponse;

    return (body.search ?? []).map((hit) => ({
      id: toConceptId(hit.id),
      scheme: 'wikidata' as const,
      label: hit.label ?? hit.id,
      description: hit.description ?? null,
      aliases: hit.aliases ?? [],
    }));
  }

  async hierarchy(conceptIds: readonly string[]): Promise<VocabularyHierarchy> {
    const qids = conceptIds.map(toQid).filter((q): q is string => q !== null);
    if (qids.length === 0) return { edges: [], concepts: [] };

    const edges: VocabularyEdge[] = [];
    const concepts = new Map<string, ConceptCandidate>();
    const seen = new Set<string>(qids);
    let frontier = [...qids];

    // Walk upward so the taxonomy view has a complete spine. Bounded: a
    // runaway walk up Wikidata's upper ontology would fetch thousands of
    // entities nobody asked for.
    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const next: string[] = [];

      for (let i = 0; i < frontier.length; i += 50) {
        const batch = frontier.slice(i, i + 50);
        const url =
          `${API}?action=wbgetentities&format=json&origin=*` +
          `&ids=${batch.join('|')}` +
          `&props=labels|descriptions|aliases|claims` +
          `&languages=${this.#language}`;

        const body = await this.#cached(url, () =>
          this.#polite(() => this.#fetchJson(url)),
        ) as EntitiesResponse;

        for (const [qid, entity] of Object.entries(body.entities ?? {})) {
          concepts.set(qid, {
            id: toConceptId(qid),
            scheme: 'wikidata',
            label: entity.labels?.[this.#language]?.value ?? qid,
            description: entity.descriptions?.[this.#language]?.value ?? null,
            aliases: (entity.aliases?.[this.#language] ?? []).map((a) => a.value),
          });

          for (const property of [P_SUBCLASS_OF, P_INSTANCE_OF]) {
            for (const claim of entity.claims?.[property] ?? []) {
              const parent = claim.mainsnak?.datavalue?.value?.id;
              if (!parent) continue;
              edges.push({
                from: toConceptId(qid),
                to: toConceptId(parent),
                // Both properties render as a parent link; `instance of` is
                // recorded as subclass_of because the taxonomy view only
                // distinguishes parent from child.
                relation: 'subclass_of',
              });
              if (!seen.has(parent)) {
                seen.add(parent);
                next.push(parent);
              }
            }
          }
        }
      }
      frontier = next;
    }

    return { edges, concepts: [...concepts.values()] };
  }
}

const defaultFetchJson: JsonFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': WIKIDATA_USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`wikidata returned HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};
