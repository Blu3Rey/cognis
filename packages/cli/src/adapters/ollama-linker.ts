/**
 * Concept disambiguation against a local Ollama model.
 *
 * Same port, same prompt, same reconciliation guard as the Claude linker — the
 * model is the only variable, which is what makes comparing them on a labelled
 * set meaningful (docs/12 §2).
 *
 * Running locally changes what goes wrong. There is no per-token bill, so
 * caching and batching stop mattering; instead the failure modes are latency,
 * context truncation and a smaller model's looser grip on an output contract.
 * Each is handled explicitly below rather than hoped away.
 *
 * ## Reaching a remote host
 *
 * The adapter only knows a base URL, so an SSH tunnel is the whole story:
 *
 *     ssh -N -L 11434:localhost:11434 you@gpu-box
 *     cognis link --linker ollama
 *
 * Point `--ollama-url` or `COGNIS_OLLAMA_URL` elsewhere if the tunnel uses a
 * different local port. Ollama has no authentication, so exposing 11434 to a
 * network is a bad idea and tunnelling is the right default.
 */

import type { Linker, LinkRequest, LinkDecision } from '@cognis/core';
import {
  LINKER_INSTRUCTIONS, LINK_OUTPUT_SCHEMA, LINKER_PROMPT_VERSION,
  renderLinkRequest, reconcileDecisions, allNil,
} from './linker-prompt.js';
import type { RawDecision } from './linker-prompt.js';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3:14b';

/**
 * Context window to request.
 *
 * This is the setting most likely to cause a silent wrong answer. Ollama
 * defaults `num_ctx` to a small value (2048 in many builds) and SILENTLY
 * TRUNCATES anything longer — so a chunk plus a dozen candidates plus the
 * instructions overflows, the model sees a prompt cut off mid-list, and it
 * answers confidently about candidates it never saw. Setting it explicitly is
 * not tuning, it is correctness.
 *
 * 16384 rather than 8192: measured prompts run 4-6k tokens, which fits in 8192
 * but leaves a chunk with an unusually long candidate list nowhere to go. The
 * cost is KV cache — roughly a gigabyte of VRAM at this size for a 14B model —
 * so on a card that cannot spare it, pass a smaller `--num-ctx` and watch the
 * truncation warning rather than letting layers spill to CPU.
 */
export const DEFAULT_NUM_CTX = 16384;

/** Local inference is slow. A 14B model on modest hardware takes real time. */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The fetch surface this adapter uses.
 *
 * `body` is optional because a GET carrying one is rejected outright by
 * Node's fetch — which a stub that ignores the rule will happily accept, so
 * the type encodes it.
 */
export type OllamaFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>;

export interface OllamaLinkerOptions {
  baseUrl?: string;
  model?: string;
  numCtx?: number;
  timeoutMs?: number;
  /**
   * qwen3 and friends emit reasoning in `<think>` blocks. Off by default:
   * this is a bounded classification, the reasoning is not used, and it costs
   * latency on every chunk.
   */
  think?: boolean;
  /**
   * Send the JSON Schema as `format`. Ollama has supported schemas since 0.5;
   * older servers only understand `format: "json"`, which constrains the
   * output to valid JSON but not to this shape.
   */
  schemaFormat?: boolean;
  onUsage?: (usage: OllamaUsage) => void;
  /** Injected in tests. */
  fetchImpl?: OllamaFetch;
}

export interface OllamaUsage {
  promptTokens: number;
  outputTokens: number;
  totalDurationMs: number;
  truncatedPrompt: boolean;
  malformedOutput: boolean;
}

interface ChatResponse {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export class OllamaUnavailableError extends Error {
  constructor(message: string, readonly remedy: string) {
    super(`${message}\n\n${remedy}`);
    this.name = 'OllamaUnavailableError';
  }
}

/**
 * Pull JSON out of a response that may not be only JSON.
 *
 * With a schema `format` the content should be bare JSON, but smaller models
 * still wrap it in a fence or prefix a sentence often enough that failing the
 * whole chunk over it would be wasteful. Reasoning blocks are stripped first
 * because `think` may be on, or on by default on some server versions.
 */
export function extractJson(content: string): unknown | null {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(withoutThinking);
  const candidates = [
    fenced?.[1]?.trim(),
    withoutThinking,
    // Last resort: the outermost braces.
    withoutThinking.slice(
      withoutThinking.indexOf('{'),
      withoutThinking.lastIndexOf('}') + 1,
    ),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

function coerceDecisions(parsed: unknown): RawDecision[] | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const decisions = (parsed as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) return null;

  const out: RawDecision[] = [];
  for (const raw of decisions) {
    if (typeof raw !== 'object' || raw === null) continue;
    const d = raw as Record<string, unknown>;
    if (typeof d['surfaceForm'] !== 'string') continue;
    out.push({
      surfaceForm: d['surfaceForm'],
      conceptId: typeof d['conceptId'] === 'string' ? d['conceptId'] : null,
      confidence: typeof d['confidence'] === 'number' ? d['confidence'] : 0,
      isPrimary: d['isPrimary'] === true,
    });
  }
  return out;
}

export class OllamaLinker implements Linker {
  readonly modelId: string;
  readonly promptVersion = LINKER_PROMPT_VERSION;
  readonly baseUrl: string;
  readonly #model: string;
  readonly #numCtx: number;
  readonly #timeoutMs: number;
  readonly #think: boolean;
  readonly #schemaFormat: boolean;
  readonly #onUsage: ((usage: OllamaUsage) => void) | undefined;
  readonly #fetch: OllamaFetch;

  constructor(opts: OllamaLinkerOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    this.#model = opts.model ?? DEFAULT_OLLAMA_MODEL;
    // The model id is recorded on every mention; the host is part of the
    // identity because two hosts can serve different weights under one name.
    this.modelId = `ollama:${this.#model}`;
    this.#numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#think = opts.think ?? false;
    this.#schemaFormat = opts.schemaFormat ?? true;
    this.#onUsage = opts.onUsage;
    this.#fetch = opts.fetchImpl ?? (globalThis.fetch as unknown as OllamaFetch);
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 404) {
          throw new OllamaUnavailableError(
            `Ollama has no model "${this.#model}" (HTTP 404)`,
            `Pull it on the host running Ollama:\n  ollama pull ${this.#model}\n\n` +
              `Then check it is listed:\n  ollama list`,
          );
        }
        throw new Error(`ollama returned HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (err) {
      if (err instanceof OllamaUnavailableError) throw err;
      if (controller.signal.aborted) {
        throw new OllamaUnavailableError(
          `Ollama did not answer within ${Math.round(this.#timeoutMs / 1000)}s`,
          `Local inference is slow, and a 14B model on modest hardware can exceed this.\n` +
            `Raise it with --ollama-timeout, or use a smaller model.`,
        );
      }
      throw new OllamaUnavailableError(
        `could not reach Ollama at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        `If Ollama runs on another machine, open a tunnel first:\n` +
          `  ssh -N -L 11434:localhost:11434 you@host\n\n` +
          `Then confirm it answers:\n  curl ${this.baseUrl}/api/tags`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Models the server has pulled. Used by `cognis doctor`. */
  async listModels(): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.#fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`ollama returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as { models?: { name?: string }[] };
      return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    } catch (err) {
      throw new OllamaUnavailableError(
        `could not reach Ollama at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        `If Ollama runs on another machine:\n` +
          `  ssh -N -L 11434:localhost:11434 you@host`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async disambiguate(req: LinkRequest): Promise<LinkDecision[]> {
    if (req.mentions.length === 0) return [];

    const body = {
      model: this.#model,
      stream: false,
      think: this.#think,
      ...(this.#schemaFormat ? { format: LINK_OUTPUT_SCHEMA } : { format: 'json' }),
      options: {
        // Disambiguation is a judgment to be made consistently, not a creative
        // task. Deterministic decoding also makes a relink reproducible.
        temperature: 0,
        num_ctx: this.#numCtx,
      },
      messages: [
        { role: 'system', content: LINKER_INSTRUCTIONS },
        { role: 'user', content: renderLinkRequest(req) },
      ],
    };

    const response = (await this.#post('/api/chat', body)) as ChatResponse;

    const promptTokens = response.prompt_eval_count ?? 0;
    // Ollama reports how many prompt tokens it actually evaluated. If that hit
    // the context ceiling the prompt was truncated and the model answered
    // about candidates it never saw — worth surfacing, not swallowing.
    const truncatedPrompt = promptTokens >= this.#numCtx;

    const content = response.message?.content ?? '';
    const parsed = extractJson(content);
    const decisions = parsed === null ? null : coerceDecisions(parsed);

    this.#onUsage?.({
      promptTokens,
      outputTokens: response.eval_count ?? 0,
      totalDurationMs: Math.round((response.total_duration ?? 0) / 1e6),
      truncatedPrompt,
      malformedOutput: decisions === null,
    });

    if (decisions === null) {
      // A local model that would not produce the contract must not take the
      // document down with it. NIL for this chunk; the run continues.
      return allNil(req);
    }

    return reconcileDecisions(req, decisions);
  }
}
