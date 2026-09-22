/**
 * The Ollama linker, against a stub server.
 *
 * No Ollama is reachable from the environment this was written in, so fetch is
 * injected and the payloads below are the real /api/chat and /api/tags response
 * shapes. What is verified is everything except the socket — and specifically
 * the failure modes that only appear when the model runs locally: silent
 * context truncation, a loose grip on the output contract, reasoning blocks in
 * the response, and a server that simply is not there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OllamaLinker, OllamaUnavailableError, extractJson,
  DEFAULT_NUM_CTX, DEFAULT_OLLAMA_MODEL,
} from '../src/adapters/ollama-linker.js';
import type { OllamaFetch, OllamaUsage } from '../src/adapters/ollama-linker.js';
import type { LinkRequest } from '@cognis/core';

const REQUEST: LinkRequest = {
  chunkId: 'c1',
  chunkText: 'Spaced repetition schedules reviews at expanding intervals.',
  sectionPath: 'Introduction',
  documentTitle: 'Learning techniques',
  mentions: [{
    surfaceForm: 'spaced repetition',
    startChar: 100,
    endChar: 117,
    candidates: [
      { id: 'wd:Q1049444', scheme: 'wikidata', label: 'spaced repetition', description: 'learning technique', aliases: [] },
      { id: 'wd:Q7075', scheme: 'wikidata', label: 'library', description: 'collection of books', aliases: [] },
    ],
  }],
};

interface Call { url: string; body: Record<string, unknown> }

function stub(
  reply: (body: Record<string, unknown>) => unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetchImpl: OllamaFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: OllamaFetch = async (url, init) => {
    // Node's fetch rejects a GET that carries a body. The stub enforces it too,
    // or it hides exactly the bug that only shows up against a real server.
    if (init.method === 'GET' && init.body !== undefined) {
      throw new Error('Request with GET/HEAD method cannot have body.');
    }
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, body });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: 'OK',
      json: async () => reply(body),
    };
  };
  return { fetchImpl, calls };
}

const chatReply = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'qwen3:14b',
  message: { role: 'assistant', content },
  done: true,
  prompt_eval_count: 900,
  eval_count: 40,
  total_duration: 3_500_000_000,
  ...extra,
});

const GOOD = JSON.stringify({
  decisions: [{
    surfaceForm: 'spaced repetition', conceptId: 'wd:Q1049444',
    confidence: 0.88, isPrimary: true,
  }],
});

test('links a surface form and keeps the request offsets', async () => {
  const { fetchImpl } = stub(() => chatReply(GOOD));
  const [decision] = await new OllamaLinker({ fetchImpl }).disambiguate(REQUEST);

  assert.equal(decision!.conceptId, 'wd:Q1049444');
  assert.equal(decision!.confidence, 0.88);
  assert.equal(decision!.isPrimary, true);
  assert.equal(decision!.startChar, 100);
  assert.equal(decision!.endChar, 117);
});

test('the model id records the provider and the host model', () => {
  const linker = new OllamaLinker({ model: 'qwen3:14b' });
  // Stored on every mention; two providers serving a model called the same
  // thing must not be confused for one another.
  assert.equal(linker.modelId, 'ollama:qwen3:14b');
  assert.equal(new OllamaLinker().modelId, `ollama:${DEFAULT_OLLAMA_MODEL}`);
});

test('an invented identifier is discarded here too', async () => {
  const { fetchImpl } = stub(() => chatReply(JSON.stringify({
    decisions: [{ surfaceForm: 'spaced repetition', conceptId: 'wd:Q88888888', confidence: 0.99, isPrimary: true }],
  })));
  const [decision] = await new OllamaLinker({ fetchImpl }).disambiguate(REQUEST);

  // A smaller model is likelier to emit a plausible-looking identifier that
  // was never offered, which makes this guard more important here, not less.
  assert.equal(decision!.conceptId, null);
  assert.equal(decision!.confidence, 0);
});

test('the context window is set explicitly, because the default truncates', async () => {
  const { fetchImpl, calls } = stub(() => chatReply(GOOD));
  await new OllamaLinker({ fetchImpl }).disambiguate(REQUEST);

  const options = calls[0]!.body['options'] as { num_ctx: number; temperature: number };
  assert.equal(options.num_ctx, DEFAULT_NUM_CTX);
  // Ollama silently truncates beyond num_ctx, so leaving it at the server
  // default would have the model answer about candidates it never saw.
  assert.ok(options.num_ctx >= 8192);
  assert.equal(options.temperature, 0, 'disambiguation must be reproducible');
});

test('a truncated prompt is reported rather than swallowed', async () => {
  const usage: OllamaUsage[] = [];
  const { fetchImpl } = stub(() => chatReply(GOOD, { prompt_eval_count: 8192 }));
  await new OllamaLinker({
    fetchImpl, numCtx: 8192, onUsage: (u) => usage.push(u),
  }).disambiguate(REQUEST);

  assert.equal(usage[0]!.truncatedPrompt, true);
});

test('a normal prompt is not flagged as truncated', async () => {
  const usage: OllamaUsage[] = [];
  const { fetchImpl } = stub(() => chatReply(GOOD, { prompt_eval_count: 900 }));
  await new OllamaLinker({
    fetchImpl, numCtx: 8192, onUsage: (u) => usage.push(u),
  }).disambiguate(REQUEST);

  assert.equal(usage[0]!.truncatedPrompt, false);
});

test('the JSON schema is sent as the format, and thinking is off', async () => {
  const { fetchImpl, calls } = stub(() => chatReply(GOOD));
  await new OllamaLinker({ fetchImpl }).disambiguate(REQUEST);

  const format = calls[0]!.body['format'] as { type: string; properties: unknown };
  assert.equal(format.type, 'object');
  assert.ok(format.properties, 'a schema, not merely format: "json"');
  assert.equal(calls[0]!.body['think'], false);
  assert.equal(calls[0]!.body['stream'], false);
});

test('older servers can be given the plain json format instead', async () => {
  const { fetchImpl, calls } = stub(() => chatReply(GOOD));
  await new OllamaLinker({ fetchImpl, schemaFormat: false }).disambiguate(REQUEST);
  assert.equal(calls[0]!.body['format'], 'json');
});

test('reasoning blocks are stripped before parsing', () => {
  const withThinking =
    '<think>The passage is about memory, so the library sense is wrong.</think>\n' + GOOD;
  const parsed = extractJson(withThinking) as { decisions: unknown[] };
  assert.equal(parsed.decisions.length, 1);
});

test('a fenced code block is still parsed', () => {
  const fenced = 'Here is the result:\n```json\n' + GOOD + '\n```';
  const parsed = extractJson(fenced) as { decisions: { conceptId: string }[] };
  assert.equal(parsed.decisions[0]!.conceptId, 'wd:Q1049444');
});

test('prose around bare JSON is tolerated', () => {
  const messy = 'Sure! ' + GOOD + ' Let me know if you need more.';
  const parsed = extractJson(messy) as { decisions: unknown[] };
  assert.equal(parsed.decisions.length, 1);
});

test('unparseable output returns null rather than throwing', () => {
  assert.equal(extractJson('I am afraid I cannot help with that.'), null);
  assert.equal(extractJson(''), null);
});

test('unusable output degrades to NIL and is counted, not fatal', async () => {
  const usage: OllamaUsage[] = [];
  const { fetchImpl } = stub(() => chatReply('I cannot produce that format.'));
  const decisions = await new OllamaLinker({
    fetchImpl, onUsage: (u) => usage.push(u),
  }).disambiguate(REQUEST);

  // A model that would not hold the contract must not take the document down.
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.conceptId, null);
  assert.equal(decisions[0]!.startChar, 100, 'offsets survive the degradation');
  assert.equal(usage[0]!.malformedOutput, true);
});

test('a missing model explains how to pull it', async () => {
  const { fetchImpl } = stub(() => ({}), { ok: false, status: 404 });
  await assert.rejects(
    new OllamaLinker({ fetchImpl, model: 'qwen3:14b' }).disambiguate(REQUEST),
    (err: unknown) => {
      assert.ok(err instanceof OllamaUnavailableError);
      assert.match(err.message, /no model "qwen3:14b"/);
      assert.match(err.message, /ollama pull qwen3:14b/);
      return true;
    },
  );
});

test('an unreachable server explains the SSH tunnel', async () => {
  const fetchImpl: OllamaFetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  };
  await assert.rejects(
    new OllamaLinker({ fetchImpl }).disambiguate(REQUEST),
    (err: unknown) => {
      assert.ok(err instanceof OllamaUnavailableError);
      assert.match(err.message, /ECONNREFUSED/);
      assert.match(err.message, /ssh -N -L 11434:localhost:11434/);
      return true;
    },
  );
});

test('a timeout says so, and says local inference is slow', async () => {
  const fetchImpl: OllamaFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  await assert.rejects(
    new OllamaLinker({ fetchImpl, timeoutMs: 30 }).disambiguate(REQUEST),
    (err: unknown) => {
      assert.ok(err instanceof OllamaUnavailableError);
      assert.match(err.message, /did not answer within/);
      assert.match(err.message, /--ollama-timeout/);
      return true;
    },
  );
});

test('the base URL is normalised and used verbatim otherwise', async () => {
  const { fetchImpl, calls } = stub(() => chatReply(GOOD));
  const linker = new OllamaLinker({ fetchImpl, baseUrl: 'http://10.0.0.5:9999/' });
  await linker.disambiguate(REQUEST);

  // A tunnel may land on any port; the adapter must not assume 11434.
  assert.equal(linker.baseUrl, 'http://10.0.0.5:9999');
  assert.equal(calls[0]!.url, 'http://10.0.0.5:9999/api/chat');
});

test('listModels reports what the server has pulled, over a bodyless GET', async () => {
  const seen: { method: string; body?: string }[] = [];
  const fetchImpl: OllamaFetch = async (_url, init) => {
    seen.push({ method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    if (init.method === 'GET' && init.body !== undefined) {
      throw new Error('Request with GET/HEAD method cannot have body.');
    }
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ models: [{ name: 'qwen3:14b' }, { name: 'llama3.2:3b' }] }),
    };
  };

  const models = await new OllamaLinker({ fetchImpl }).listModels();
  assert.deepEqual(models, ['qwen3:14b', 'llama3.2:3b']);
  assert.equal(seen[0]!.method, 'GET');
  assert.equal(seen[0]!.body, undefined, 'a GET must not carry a body');
});

test('no mentions means no request at all', async () => {
  const { fetchImpl, calls } = stub(() => chatReply(GOOD));
  const decisions = await new OllamaLinker({ fetchImpl }).disambiguate({
    ...REQUEST, mentions: [],
  });
  assert.deepEqual(decisions, []);
  assert.equal(calls.length, 0);
});
