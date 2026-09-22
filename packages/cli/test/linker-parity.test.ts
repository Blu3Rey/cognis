/**
 * The two linkers must differ only in the model.
 *
 * The reason for having more than one is to compare them on the same labelled
 * set (docs/12 §2). Two linkers with two prompts, or two reconciliation rules,
 * would measure those differences instead — so the shared pieces are asserted
 * to be genuinely shared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeLinker } from '../src/adapters/claude-linker.js';
import { OllamaLinker } from '../src/adapters/ollama-linker.js';
import type { OllamaFetch } from '../src/adapters/ollama-linker.js';
import {
  LINKER_INSTRUCTIONS, LINKER_PROMPT_VERSION, renderLinkRequest,
} from '../src/adapters/linker-prompt.js';
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
      { id: 'wd:Q7075', scheme: 'wikidata', label: 'library', description: 'books', aliases: [] },
    ],
  }],
};

test('both linkers report the same prompt version', () => {
  const claude = new ClaudeLinker({ client: {} as Anthropic });
  const ollama = new OllamaLinker();
  // Mentions record the prompt version. If these diverged, two runs would look
  // comparable in the data and not be.
  assert.equal(claude.promptVersion, ollama.promptVersion);
  assert.equal(claude.promptVersion, LINKER_PROMPT_VERSION);
});

test('both send byte-identical instructions and rendering', async () => {
  const claudeCaptured: Record<string, unknown>[] = [];
  const claudeClient = {
    messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: { decisions: [] }, usage: {} }) },
    beta: {
      messages: {
        parse: async (p: Record<string, unknown>) => {
          claudeCaptured.push(p);
          return { stop_reason: 'end_turn', parsed_output: { decisions: [] }, usage: {} };
        },
      },
    },
  } as unknown as Anthropic;

  const ollamaCaptured: Record<string, unknown>[] = [];
  const fetchImpl: OllamaFetch = async (_url, init) => {
    ollamaCaptured.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ message: { content: '{"decisions":[]}' }, done: true }),
    };
  };

  await new ClaudeLinker({ client: claudeClient }).disambiguate(REQUEST);
  await new OllamaLinker({ fetchImpl }).disambiguate(REQUEST);

  const claudeSystem = (claudeCaptured[0]!['system'] as { text: string }[])[0]!.text;
  const ollamaMessages = ollamaCaptured[0]!['messages'] as { role: string; content: string }[];
  const ollamaSystem = ollamaMessages.find((m) => m.role === 'system')!.content;
  assert.equal(claudeSystem, ollamaSystem);
  assert.equal(claudeSystem, LINKER_INSTRUCTIONS);

  const claudeUser = (claudeCaptured[0]!['messages'] as { content: string }[])[0]!.content;
  const ollamaUser = ollamaMessages.find((m) => m.role === 'user')!.content;
  assert.equal(claudeUser, ollamaUser);
  assert.equal(claudeUser, renderLinkRequest(REQUEST));
});

test('both reject an invented identifier identically', async () => {
  const bad = {
    decisions: [{ surfaceForm: 'spaced repetition', conceptId: 'wd:Q404404', confidence: 1, isPrimary: true }],
  };

  const claudeClient = {
    messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: bad, usage: {} }) },
    beta: { messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: bad, usage: {} }) } },
  } as unknown as Anthropic;
  const fetchImpl: OllamaFetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ message: { content: JSON.stringify(bad) }, done: true }),
  });

  const [fromClaude] = await new ClaudeLinker({ client: claudeClient }).disambiguate(REQUEST);
  const [fromOllama] = await new OllamaLinker({ fetchImpl }).disambiguate(REQUEST);

  assert.deepEqual(fromClaude, fromOllama);
  assert.equal(fromClaude!.conceptId, null);
});

test('both degrade to NIL with the request offsets intact', async () => {
  const claudeClient = {
    messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null, usage: {} }) },
    beta: { messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null, usage: {} }) } },
  } as unknown as Anthropic;
  const fetchImpl: OllamaFetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ message: { content: 'not json at all' }, done: true }),
  });

  const [fromClaude] = await new ClaudeLinker({ client: claudeClient }).disambiguate(REQUEST);
  const [fromOllama] = await new OllamaLinker({ fetchImpl }).disambiguate(REQUEST);

  // Different causes — a policy refusal and a malformed local response — but
  // the pipeline must see the same shape from both.
  assert.deepEqual(fromClaude, fromOllama);
  assert.equal(fromClaude!.startChar, 100);
});
