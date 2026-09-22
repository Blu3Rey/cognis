/**
 * The linking prompt, shared by every linker implementation.
 *
 * This is deliberately not duplicated per provider. The point of having more
 * than one linker is to compare them on the same labelled set (docs/12 §2),
 * and two linkers with two prompts measure the prompt as much as the model.
 * Same instructions, same rendering, same candidate list — the model is the
 * only variable.
 */

import type { LinkRequest } from '@cognis/core';

export const LINKER_PROMPT_VERSION = 'linker-prompt@1.0.0';

/**
 * Stable across every call so it caches where caching exists.
 *
 * Changing a byte here changes the prompt version, because mentions record
 * which prompt produced them and a silent edit would make two runs
 * incomparable.
 */
export const LINKER_INSTRUCTIONS = `You are a concept linker for a personal knowledge management system.

For each surface form found in a passage, you choose which of the supplied
candidate concepts it refers to — or decide that none of them fits.

Rules:

1. Choose ONLY from the candidate ids given for that surface form. Never invent
   an identifier, and never return an id supplied for a different surface form.
2. If no candidate is the concept the passage actually means, return null. A
   missing link is recoverable; a wrong link silently corrupts every count
   built on top of it. Prefer null when genuinely unsure.
3. confidence is your probability that the chosen candidate is correct, from
   0 to 1. Use the full range. If you return null, confidence expresses how
   sure you are that none of the candidates fit.
4. isPrimary answers a different question: is this passage's document ABOUT
   this concept, or does it merely mention it? A passing reference, an example,
   or a citation is not primary. Something the document explains, argues about
   or is centred on is primary. Most mentions are NOT primary.
5. Judge the surface form as the passage uses it, not as the word is most
   commonly used elsewhere. Acronyms and common words are the usual traps.

Return one decision per surface form you were given, in the order given.`;

/** Renders the volatile half of the request: the passage and its candidates. */
export function renderLinkRequest(req: LinkRequest): string {
  const lines: string[] = [];
  if (req.documentTitle) lines.push(`Document title: ${req.documentTitle}`);
  if (req.sectionPath) lines.push(`Section: ${req.sectionPath}`);
  lines.push('', 'Passage:', req.chunkText, '', 'Surface forms and candidates:');

  for (const [i, mention] of req.mentions.entries()) {
    lines.push('', `${i + 1}. "${mention.surfaceForm}"`);
    if (mention.candidates.length === 0) {
      lines.push('   (no candidates — the only valid answer is null)');
      continue;
    }
    for (const c of mention.candidates) {
      const aliases = c.aliases.length ? ` [also: ${c.aliases.slice(0, 4).join(', ')}]` : '';
      lines.push(
        `   - ${c.id}: ${c.label}${c.description ? ` — ${c.description}` : ''}${aliases}`,
      );
    }
  }
  return lines.join('\n');
}

/** One decision as every linker must return it, before validation. */
export interface RawDecision {
  surfaceForm: string;
  conceptId: string | null;
  confidence: number;
  isPrimary: boolean;
}

/**
 * JSON Schema for the output contract.
 *
 * Hand-written rather than generated: it is small, it is shared by providers
 * with different schema dialects, and the exact shape is load-bearing enough
 * to be worth reading directly.
 */
export const LINK_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          surfaceForm: { type: 'string' },
          conceptId: { type: ['string', 'null'] },
          confidence: { type: 'number' },
          isPrimary: { type: 'boolean' },
        },
        required: ['surfaceForm', 'conceptId', 'confidence', 'isPrimary'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
} as const;

/**
 * Match decisions back onto the mentions and discard anything unsupportable.
 *
 * Shared because it is the guard that matters most and it must behave
 * identically whichever model produced the decisions:
 *
 *  - An id that was never offered for THIS surface form is dropped. A
 *    hallucinated identifier would enter the graph as a real node and be
 *    nearly impossible to spot later — and a smaller model is likelier to
 *    produce a plausible-looking one.
 *  - Offsets come from the request, never from the model, so an echoed-back
 *    mistake cannot anchor evidence to the wrong span.
 */
export function reconcileDecisions(
  req: LinkRequest,
  decisions: readonly RawDecision[],
): { surfaceForm: string; startChar: number; endChar: number; conceptId: string | null; confidence: number; isPrimary: boolean }[] {
  const allowed = new Map<string, Set<string>>();
  for (const m of req.mentions) {
    allowed.set(m.surfaceForm, new Set(m.candidates.map((c) => c.id)));
  }

  const bySurface = new Map<string, RawDecision[]>();
  for (const d of decisions) {
    const list = bySurface.get(d.surfaceForm) ?? [];
    list.push(d);
    bySurface.set(d.surfaceForm, list);
  }

  return req.mentions.map((mention) => {
    const decision = bySurface.get(mention.surfaceForm)?.shift();
    const permitted = allowed.get(mention.surfaceForm) ?? new Set<string>();
    const conceptId =
      decision?.conceptId && permitted.has(decision.conceptId)
        ? decision.conceptId
        : null;

    return {
      surfaceForm: mention.surfaceForm,
      startChar: mention.startChar,
      endChar: mention.endChar,
      conceptId,
      confidence: conceptId ? Math.max(0, Math.min(1, decision?.confidence ?? 0)) : 0,
      isPrimary: conceptId ? decision?.isPrimary === true : false,
    };
  });
}

/** Every surface form as NIL. The safe degradation when a call cannot produce answers. */
export function allNil(req: LinkRequest): ReturnType<typeof reconcileDecisions> {
  return req.mentions.map((m) => ({
    surfaceForm: m.surfaceForm,
    startChar: m.startChar,
    endChar: m.endChar,
    conceptId: null,
    confidence: 0,
    isPrimary: false,
  }));
}
