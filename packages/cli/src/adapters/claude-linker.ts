/**
 * Concept disambiguation with Claude.
 *
 * The model's job is CHOOSING among candidates the vocabulary retrieved, never
 * naming concepts (ADR-0005). That distinction is the architectural bet: a
 * choice from a finite set has a correct answer, so precision is measurable
 * and a regression is catchable. Nothing here may invent an identifier.
 *
 * Three things this adapter is careful about:
 *
 *  - **Prompt caching.** The instructions and the output contract are byte
 *    identical on every call and carry the cache breakpoint; the chunk and its
 *    candidates come after it. Linking is the dominant recurring model cost
 *    (docs/08), and the prefix is most of each request.
 *  - **Refusals.** A corpus is arbitrary web text, and an ingestion pipeline
 *    must not stall because one chunk tripped a classifier. Server-side
 *    fallbacks are on by default; a refusal that survives them degrades to NIL
 *    for that chunk rather than throwing away the document.
 *  - **Never inventing ids.** Any concept id the model returns that was not in
 *    the candidate list is discarded, because a hallucinated QID would enter
 *    the graph as a real node and be almost impossible to spot later.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Linker, LinkRequest, LinkDecision } from '@cognis/core';

export const LINKER_PROMPT_VERSION = 'claude-linker@1.0.0';
export const DEFAULT_LINKER_MODEL = 'claude-opus-5';

/**
 * The output contract.
 *
 * `conceptId` is nullable because NIL is a first-class answer: over-eager
 * anchoring is how a graph fills with wrong nodes, and a wrong anchor is far
 * harder to notice than a missing one.
 */
const Decision = z.object({
  surfaceForm: z.string(),
  conceptId: z.string().nullable(),
  confidence: z.number(),
  isPrimary: z.boolean(),
});
const LinkDecisions = z.object({ decisions: z.array(Decision) });

/**
 * Stable across every call, so it caches. Changing a byte here invalidates the
 * cache for the whole run, which is why the prompt version is pinned and
 * recorded on every mention.
 */
const INSTRUCTIONS = `You are a concept linker for a personal knowledge management system.

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

export interface ClaudeLinkerOptions {
  client?: Anthropic;
  model?: string;
  /** Bounded choice over a candidate list; measure before raising. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /** Server-side refusal fallbacks. On by default. */
  fallbackModel?: string | null;
  /** Called with token usage after every call, for cost reporting. */
  onUsage?: (usage: LinkerUsage) => void;
}

export interface LinkerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  refused: boolean;
}

function renderRequest(req: LinkRequest): string {
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
      lines.push(`   - ${c.id}: ${c.label}${c.description ? ` — ${c.description}` : ''}${aliases}`);
    }
  }
  return lines.join('\n');
}

export class ClaudeLinker implements Linker {
  readonly modelId: string;
  readonly promptVersion = LINKER_PROMPT_VERSION;
  readonly #client: Anthropic;
  readonly #effort: NonNullable<ClaudeLinkerOptions['effort']>;
  readonly #maxTokens: number;
  readonly #fallbackModel: string | null;
  readonly #onUsage: ((usage: LinkerUsage) => void) | undefined;

  constructor(opts: ClaudeLinkerOptions = {}) {
    this.#client = opts.client ?? new Anthropic();
    this.modelId = opts.model ?? DEFAULT_LINKER_MODEL;
    this.#effort = opts.effort ?? 'low';
    this.#maxTokens = opts.maxTokens ?? 8000;
    this.#fallbackModel = opts.fallbackModel === undefined
      ? 'claude-opus-4-8'
      : opts.fallbackModel;
    this.#onUsage = opts.onUsage;
  }

  async disambiguate(req: LinkRequest): Promise<LinkDecision[]> {
    if (req.mentions.length === 0) return [];

    // Anything the model returns must be traceable to a candidate we supplied.
    const allowed = new Map<string, Set<string>>();
    for (const m of req.mentions) {
      allowed.set(m.surfaceForm, new Set(m.candidates.map((c) => c.id)));
    }

    const params = {
      model: this.modelId,
      max_tokens: this.#maxTokens,
      thinking: { type: 'adaptive' as const },
      output_config: {
        effort: this.#effort,
        format: zodOutputFormat(LinkDecisions),
      },
      system: [
        {
          type: 'text' as const,
          text: INSTRUCTIONS,
          // The breakpoint sits at the end of the stable prefix; everything
          // volatile is in the user message after it.
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      messages: [{ role: 'user' as const, content: renderRequest(req) }],
    };

    const client = this.#client;
    let response;
    try {
      response = this.#fallbackModel
        ? await client.beta.messages.parse({
            ...params,
            betas: ['server-side-fallback-2026-06-01'],
            fallbacks: [{ model: this.#fallbackModel }],
          } as Parameters<typeof client.beta.messages.parse>[0])
        : await client.messages.parse(params);
    } catch (err) {
      // Most specific first; a rate limit is retryable and a bad request is not,
      // and collapsing them loses the distinction the caller needs.
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error(`linker rate limited: ${err.message}`, { cause: err });
      }
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error(
          'linker could not authenticate. Set ANTHROPIC_API_KEY, or run `ant auth login`.',
          { cause: err },
        );
      }
      throw err;
    }

    const usage = response.usage as {
      input_tokens?: number; output_tokens?: number;
      cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
    };
    const refused = response.stop_reason === 'refusal';

    this.#onUsage?.({
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      refused,
    });

    if (refused) {
      // One chunk tripping a classifier must not abort a document. Every
      // surface form becomes NIL, which the pipeline already handles.
      return req.mentions.map((m) => ({
        surfaceForm: m.surfaceForm,
        startChar: m.startChar,
        endChar: m.endChar,
        conceptId: null,
        confidence: 0,
        isPrimary: false,
      }));
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error(
        `linker returned no parseable output (stop_reason ${response.stop_reason})`,
      );
    }

    // Match decisions back to the mentions by surface form, in order, so a
    // model that returns them out of order or drops one cannot shift offsets
    // onto the wrong span.
    const bySurface = new Map<string, typeof parsed.decisions>();
    for (const d of parsed.decisions) {
      const list = bySurface.get(d.surfaceForm) ?? [];
      list.push(d);
      bySurface.set(d.surfaceForm, list);
    }

    return req.mentions.map((mention) => {
      const decision = bySurface.get(mention.surfaceForm)?.shift();
      const permitted = allowed.get(mention.surfaceForm) ?? new Set<string>();

      // A returned id that was never offered is discarded. A hallucinated QID
      // would enter the graph as a real node and be nearly impossible to spot.
      const conceptId =
        decision?.conceptId && permitted.has(decision.conceptId)
          ? decision.conceptId
          : null;

      return {
        surfaceForm: mention.surfaceForm,
        startChar: mention.startChar,
        endChar: mention.endChar,
        conceptId,
        confidence: conceptId
          ? Math.max(0, Math.min(1, decision?.confidence ?? 0))
          : 0,
        isPrimary: conceptId ? decision?.isPrimary === true : false,
      };
    });
  }
}

/** Claude Opus 5 list price, for the cost line the CLI prints. */
export const OPUS_5_INPUT_PER_MTOK = 5;
export const OPUS_5_OUTPUT_PER_MTOK = 25;
/** Cache reads bill at roughly a tenth of input. */
export const CACHE_READ_MULTIPLIER = 0.1;

export function estimateCost(usage: LinkerUsage[]): {
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  refusals: number; usd: number;
} {
  const total = usage.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      refusals: acc.refusals + (u.refused ? 1 : 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, refusals: 0 },
  );

  const usd =
    (total.inputTokens / 1e6) * OPUS_5_INPUT_PER_MTOK +
    (total.cacheReadTokens / 1e6) * OPUS_5_INPUT_PER_MTOK * CACHE_READ_MULTIPLIER +
    (total.outputTokens / 1e6) * OPUS_5_OUTPUT_PER_MTOK;

  return { ...total, usd };
}
