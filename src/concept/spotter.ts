/**
 * Candidate spotting.
 *
 * Finds surface forms worth looking up. Cheap signals first — no model call
 * here, because a model pass over every chunk before candidate generation
 * would double the linking bill for work that heuristics do adequately
 * (docs/04-concept-identity.md § The linking pipeline, step 1).
 *
 * Pure and deterministic, so respotting is part of a scoped rebuild.
 */

export const SPOTTER_VERSION = '1.0.0';

export interface Spot {
  surfaceForm: string;
  /** Offsets relative to the text passed in. */
  startChar: number;
  endChar: number;
  /** Which heuristic fired. Useful when debugging linker precision. */
  signal: 'proper_noun' | 'acronym' | 'keyword' | 'definition' | 'recurring' | 'ngram';
}

export interface SpotOptions {
  /** Publisher keywords or subject terms, when the source supplied them. */
  keywords?: readonly string[];
  /** Minimum repeats for the recurring-term heuristic. */
  recurrenceThreshold?: number;
  maxSpots?: number;
  /** Longest noun-phrase n-gram to emit. */
  maxNgram?: number;
}

/**
 * Words that start sentences and open clauses. Without this, "The", "This" and
 * every sentence-initial word become candidate proper nouns and the candidate
 * generator is flooded with noise.
 */
const STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'a', 'an', 'and', 'or', 'but',
  'if', 'then', 'when', 'while', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
  'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'we', 'they', 'he', 'she', 'you', 'i', 'there', 'here', 'however',
  'therefore', 'thus', 'also', 'more', 'most', 'some', 'many', 'such',
  'because', 'although', 'both', 'each', 'other', 'their', 'our', 'his', 'her',
]);

const PROPER_NOUN = /\b([A-Z][a-z]+(?:\s+(?:of|de|van|der|the)\s+)?(?:\s+[A-Z][a-z]+){0,3})\b/g;
const ACRONYM = /\b([A-Z]{2,6})(?:s)?\b/g;
const DEFINITION = /\b([a-z][a-z\s-]{2,40}?)\s+(?:is|are|refers? to|means|denotes)\s+(?:a|an|the)\b/gi;

function isSentenceStart(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\n' || ch === '\t') continue;
    return ch === '.' || ch === '!' || ch === '?' || ch === '\n';
  }
  return true;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Word tokens with absolute offsets.
 *
 * N-gram emission needs real offsets, and recovering them from a split() is
 * error-prone, so tokens carry their own positions.
 */
function tokenise(text: string): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
  for (const m of text.matchAll(re)) {
    if (m.index === undefined) continue;
    out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Noun-phrase n-grams.
 *
 * Most concepts worth linking appear in prose as lowercase multi-word phrases
 * — "spaced repetition", "retrieval practice", "entity linking". A spotter
 * that only recognises capitalised proper nouns misses nearly all of them,
 * which is precisely the class of concept a knowledge system exists to track.
 *
 * These are candidate spans, not assertions: candidate generation discards any
 * n-gram the vocabulary does not recognise, so a loose spotter costs lookups
 * rather than precision. That is also why vocabulary lookups are pooled and
 * cached at the backend (docs/01-architecture.md).
 */
function ngramSpots(text: string, maxNgram: number): Spot[] {
  const tokens = tokenise(text);
  const spots: Spot[] = [];

  for (let n = maxNgram; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const window = tokens.slice(i, i + n);
      const first = window[0]!;
      const last = window[window.length - 1]!;

      // A phrase bounded by a stopword is a fragment, not a concept.
      if (STOPWORDS.has(first.word.toLowerCase())) continue;
      if (STOPWORDS.has(last.word.toLowerCase())) continue;

      // Do not cross sentence boundaries: the span between two tokens must
      // contain no terminal punctuation.
      const between = text.slice(first.start, last.end);
      if (/[.!?;:]/.test(between)) continue;

      if (n === 1) {
        // Single words flood the candidate set, so only keep substantial ones.
        if (first.word.length < 6) continue;
        if (STOPWORDS.has(first.word.toLowerCase())) continue;
      }

      spots.push({
        surfaceForm: text.slice(first.start, last.end),
        startChar: first.start,
        endChar: last.end,
        signal: 'ngram',
      });
    }
  }
  return spots;
}

/** Longer and more specific signals win a contested `maxSpots` budget. */
const SIGNAL_PRIORITY: Record<Spot['signal'], number> = {
  definition: 0,
  keyword: 1,
  recurring: 2,
  acronym: 3,
  proper_noun: 4,
  ngram: 5,
};

export function spotMentions(text: string, opts: SpotOptions = {}): Spot[] {
  const recurrenceThreshold = opts.recurrenceThreshold ?? 3;
  const maxSpots = opts.maxSpots ?? 60;
  const maxNgram = opts.maxNgram ?? 3;

  const found = new Map<string, Spot>();
  const key = (s: Spot) => `${s.startChar}:${s.endChar}`;
  const add = (s: Spot) => {
    if (!found.has(key(s))) found.set(key(s), s);
  };

  // Proper nouns, skipping sentence-initial words that are merely capitalised
  // by position rather than by being names.
  for (const m of text.matchAll(PROPER_NOUN)) {
    const raw = m[1];
    if (!raw || m.index === undefined) continue;
    const trimmed = raw.trim();
    const words = trimmed.split(/\s+/);
    if (words.length === 1) {
      if (STOPWORDS.has(trimmed.toLowerCase())) continue;
      if (isSentenceStart(text, m.index)) continue;
    }
    if (trimmed.length < 3) continue;
    add({
      surfaceForm: trimmed,
      startChar: m.index,
      endChar: m.index + trimmed.length,
      signal: 'proper_noun',
    });
  }

  for (const m of text.matchAll(ACRONYM)) {
    const raw = m[1];
    if (!raw || m.index === undefined) continue;
    add({
      surfaceForm: raw,
      startChar: m.index,
      endChar: m.index + raw.length,
      signal: 'acronym',
    });
  }

  // "X is a ..." is the strongest in-text signal that X is a concept the
  // author considers worth defining.
  for (const m of text.matchAll(DEFINITION)) {
    const raw = m[1];
    if (!raw || m.index === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length < 3 || STOPWORDS.has(trimmed.toLowerCase())) continue;
    const start = m.index + m[0].indexOf(trimmed);
    add({
      surfaceForm: trimmed,
      startChar: start,
      endChar: start + trimmed.length,
      signal: 'definition',
    });
  }

  for (const kw of opts.keywords ?? []) {
    if (!kw.trim()) continue;
    const needle = normalise(kw);
    const hay = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      add({
        surfaceForm: text.slice(at, at + needle.length),
        startChar: at,
        endChar: at + needle.length,
        signal: 'keyword',
      });
      from = at + needle.length;
    }
  }

  for (const s of ngramSpots(text, maxNgram)) add(s);

  // Terms the document keeps returning to are what it is about.
  const counts = new Map<string, Spot[]>();
  for (const s of found.values()) {
    const n = normalise(s.surfaceForm);
    const list = counts.get(n) ?? [];
    list.push(s);
    counts.set(n, list);
  }
  for (const [, spots] of counts) {
    if (spots.length >= recurrenceThreshold) {
      for (const s of spots) if (s.signal === 'proper_noun') s.signal = 'recurring';
    }
  }

  // Deduplicate by surface form, keeping the first occurrence: candidate
  // generation is per form, and looking the same string up ten times is waste.
  const bySurface = new Map<string, Spot>();
  for (const s of [...found.values()].sort((a, b) => a.startChar - b.startChar)) {
    const n = normalise(s.surfaceForm);
    const existing = bySurface.get(n);
    if (!existing || SIGNAL_PRIORITY[s.signal] < SIGNAL_PRIORITY[existing.signal]) {
      bySurface.set(n, s);
    }
  }

  // Rank before truncating, so a `maxSpots` cap drops the weakest candidates
  // rather than whatever happened to come last in the document.
  return [...bySurface.values()]
    .sort((a, b) => {
      const bySignal = SIGNAL_PRIORITY[a.signal] - SIGNAL_PRIORITY[b.signal];
      if (bySignal !== 0) return bySignal;
      const byLength = b.surfaceForm.length - a.surfaceForm.length;
      if (byLength !== 0) return byLength;
      return a.startChar - b.startChar;
    })
    .slice(0, maxSpots)
    .sort((a, b) => a.startChar - b.startChar);
}
