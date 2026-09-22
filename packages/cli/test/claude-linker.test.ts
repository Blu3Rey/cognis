/**
 * The Claude linker, against a stub client.
 *
 * No API key exists in the environment this was written in, so the Anthropic
 * client is injected. What is verified is everything the adapter is
 * responsible for: that it never accepts an invented identifier, that it
 * degrades to NIL rather than dropping a document on a refusal, that the cache
 * breakpoint is where it claims to be, and that offsets stay attached to the
 * right span.
 *
 * What is NOT verified is that the real API accepts this request shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeLinker, estimateCost } from '../src/adapters/claude-linker.js';
import type { LinkerUsage } from '../src/adapters/claude-linker.js';
import type { LinkRequest } from '@cognis/core';

interface Captured { params: Record<string, unknown>; beta: boolean }

/** Stands in for the SDK: records the request, returns a scripted response. */
function stubClient(
  respond: (params: Record<string, unknown>) => unknown,
): { client: Anthropic; captured: Captured[] } {
  const captured: Captured[] = [];
  const make = (beta: boolean) => async (params: Record<string, unknown>) => {
    captured.push({ params, beta });
    return respond(params);
  };
  const client = {
    messages: { parse: make(false) },
    beta: { messages: { parse: make(true) } },
  } as unknown as Anthropic;
  return { client, captured };
}

function ok(decisions: unknown[], usage: Record<string, number> = {}) {
  return {
    stop_reason: 'end_turn',
    parsed_output: { decisions },
    usage: {
      input_tokens: 1200, output_tokens: 200,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      ...usage,
    },
  };
}

const REQUEST: LinkRequest = {
  chunkId: 'c1',
  chunkText: 'Spaced repetition schedules reviews at expanding intervals.',
  sectionPath: 'Introduction',
  documentTitle: 'Learning techniques',
  mentions: [
    {
      surfaceForm: 'spaced repetition',
      startChar: 100,
      endChar: 117,
      candidates: [
        {
          id: 'wd:Q1049444', scheme: 'wikidata', label: 'spaced repetition',
          description: 'learning technique', aliases: ['distributed practice'],
        },
        {
          id: 'wd:Q7075', scheme: 'wikidata', label: 'library',
          description: 'collection of books', aliases: [],
        },
      ],
    },
  ],
};

test('returns the chosen candidate with the original offsets', async () => {
  const { client } = stubClient(() =>
    ok([{
      surfaceForm: 'spaced repetition', conceptId: 'wd:Q1049444',
      confidence: 0.93, isPrimary: true,
    }]),
  );
  const linker = new ClaudeLinker({ client });

  const [decision] = await linker.disambiguate(REQUEST);

  assert.equal(decision!.conceptId, 'wd:Q1049444');
  assert.equal(decision!.confidence, 0.93);
  assert.equal(decision!.isPrimary, true);
  // Offsets come from the request, never from the model: a model that echoed
  // them back wrong would anchor evidence to the wrong span.
  assert.equal(decision!.startChar, 100);
  assert.equal(decision!.endChar, 117);
});

test('an invented identifier is discarded, not stored', async () => {
  const { client } = stubClient(() =>
    ok([{
      surfaceForm: 'spaced repetition', conceptId: 'wd:Q99999999',
      confidence: 0.99, isPrimary: true,
    }]),
  );
  const linker = new ClaudeLinker({ client });

  const [decision] = await linker.disambiguate(REQUEST);

  // A hallucinated QID would enter the graph as a real node and be nearly
  // impossible to spot afterwards.
  assert.equal(decision!.conceptId, null);
  assert.equal(decision!.confidence, 0);
  assert.equal(decision!.isPrimary, false);
});

test('a candidate offered for a different surface form is not accepted', async () => {
  const request: LinkRequest = {
    ...REQUEST,
    mentions: [
      REQUEST.mentions[0]!,
      {
        surfaceForm: 'intervals', startChar: 140, endChar: 149,
        candidates: [{
          id: 'wd:Q186885', scheme: 'wikidata', label: 'interval',
          description: 'mathematical concept', aliases: [],
        }],
      },
    ],
  };
  const { client } = stubClient(() =>
    ok([
      // Cross-assigned: the id belongs to the other mention.
      { surfaceForm: 'spaced repetition', conceptId: 'wd:Q186885', confidence: 0.9, isPrimary: false },
      { surfaceForm: 'intervals', conceptId: 'wd:Q186885', confidence: 0.8, isPrimary: false },
    ]),
  );
  const linker = new ClaudeLinker({ client });

  const decisions = await linker.disambiguate(request);
  assert.equal(decisions[0]!.conceptId, null, 'cross-assigned id must be rejected');
  assert.equal(decisions[1]!.conceptId, 'wd:Q186885', 'its own mention still links');
});

test('NIL is passed through as a real answer', async () => {
  const { client } = stubClient(() =>
    ok([{ surfaceForm: 'spaced repetition', conceptId: null, confidence: 0.8, isPrimary: false }]),
  );
  const linker = new ClaudeLinker({ client });
  const [decision] = await linker.disambiguate(REQUEST);
  assert.equal(decision!.conceptId, null);
});

test('a refusal degrades to NIL instead of losing the document', async () => {
  const { client } = stubClient(() => ({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
    parsed_output: null,
    usage: { input_tokens: 900, output_tokens: 0 },
  }));
  const usage: LinkerUsage[] = [];
  const linker = new ClaudeLinker({ client, onUsage: (u) => usage.push(u) });

  const decisions = await linker.disambiguate(REQUEST);

  // One chunk tripping a classifier must not abort an ingestion run.
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.conceptId, null);
  assert.equal(decisions[0]!.startChar, 100);
  assert.equal(usage[0]!.refused, true, 'the refusal must be visible in the cost report');
});

test('refusal fallbacks are on by default, and can be turned off', async () => {
  const withFallback = stubClient(() => ok([]));
  await new ClaudeLinker({ client: withFallback.client }).disambiguate(REQUEST);
  assert.equal(withFallback.captured[0]!.beta, true, 'fallbacks need the beta path');
  assert.deepEqual(
    withFallback.captured[0]!.params['betas'],
    ['server-side-fallback-2026-06-01'],
  );
  assert.deepEqual(
    withFallback.captured[0]!.params['fallbacks'],
    [{ model: 'claude-opus-4-8' }],
  );

  const without = stubClient(() => ok([]));
  await new ClaudeLinker({ client: without.client, fallbackModel: null }).disambiguate(REQUEST);
  assert.equal(without.captured[0]!.beta, false);
  assert.equal(without.captured[0]!.params['betas'], undefined);
});

test('the cache breakpoint sits on the stable instructions, not the passage', async () => {
  const { client, captured } = stubClient(() => ok([]));
  await new ClaudeLinker({ client }).disambiguate(REQUEST);

  const system = captured[0]!.params['system'] as {
    text: string; cache_control?: { type: string };
  }[];
  assert.equal(system[0]!.cache_control?.type, 'ephemeral');

  // Caching is a prefix match, so anything varying per call must come after
  // the breakpoint or the cache never hits.
  assert.ok(!system[0]!.text.includes('Spaced repetition schedules'));
  const messages = captured[0]!.params['messages'] as { content: string }[];
  assert.ok(messages[0]!.content.includes('Spaced repetition schedules'));
  assert.ok(messages[0]!.content.includes('wd:Q1049444'));
});

test('the instruction prefix is byte-identical across calls', async () => {
  const { client, captured } = stubClient(() => ok([]));
  const linker = new ClaudeLinker({ client });
  await linker.disambiguate(REQUEST);
  await linker.disambiguate({ ...REQUEST, chunkId: 'c2', chunkText: 'Different text.' });

  const first = (captured[0]!.params['system'] as { text: string }[])[0]!.text;
  const second = (captured[1]!.params['system'] as { text: string }[])[0]!.text;
  assert.equal(first, second, 'a varying prefix silently disables caching');
});

test('model, thinking and effort are set as the API expects', async () => {
  const { client, captured } = stubClient(() => ok([]));
  await new ClaudeLinker({ client, effort: 'medium' }).disambiguate(REQUEST);

  const p = captured[0]!.params;
  assert.equal(p['model'], 'claude-opus-5');
  assert.deepEqual(p['thinking'], { type: 'adaptive' });
  const outputConfig = p['output_config'] as { effort: string; format: unknown };
  assert.equal(outputConfig.effort, 'medium');
  assert.ok(outputConfig.format, 'structured output is how the contract is enforced');
});

test('a mention with no candidates is never linked', async () => {
  const request: LinkRequest = {
    ...REQUEST,
    mentions: [{
      surfaceForm: 'Frobnicator', startChar: 5, endChar: 16, candidates: [],
    }],
  };
  const { client, captured } = stubClient(() =>
    ok([{ surfaceForm: 'Frobnicator', conceptId: 'wd:Q1', confidence: 1, isPrimary: true }]),
  );
  const [decision] = await new ClaudeLinker({ client }).disambiguate(request);

  assert.equal(decision!.conceptId, null);
  const messages = captured[0]!.params['messages'] as { content: string }[];
  assert.match(messages[0]!.content, /no candidates/);
});

test('no mentions means no request at all', async () => {
  const { client, captured } = stubClient(() => ok([]));
  const decisions = await new ClaudeLinker({ client }).disambiguate({
    ...REQUEST, mentions: [],
  });
  assert.deepEqual(decisions, []);
  assert.equal(captured.length, 0, 'an empty chunk should not be paid for');
});

test('confidence is clamped into range', async () => {
  const { client } = stubClient(() =>
    ok([{ surfaceForm: 'spaced repetition', conceptId: 'wd:Q1049444', confidence: 4.2, isPrimary: true }]),
  );
  const [decision] = await new ClaudeLinker({ client }).disambiguate(REQUEST);
  // The schema constrains confidence to 0..1; an out-of-range value would be
  // rejected by the database CHECK constraint.
  assert.equal(decision!.confidence, 1);
});

test('cost reporting accounts for cached reads separately', () => {
  const cost = estimateCost([
    { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, refused: false },
  ]);
  assert.equal(cost.usd, 5, 'one million input tokens at $5/MTok');

  const cached = estimateCost([
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0, refused: false },
  ]);
  assert.ok(cached.usd < cost.usd, 'cache reads must be cheaper than fresh input');

  const output = estimateCost([
    { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, refused: false },
  ]);
  assert.equal(output.usd, 25);
});
