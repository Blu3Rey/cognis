/**
 * The embedder adapter, tested against an injected pipeline.
 *
 * The model weights themselves cannot be downloaded in every environment (this
 * one blocks huggingface.co outright), so the loader is a constructor argument
 * and everything around it — batching, dimension checks, normalisation
 * passthrough, error messages — is verified without 23MB of weights. What is
 * NOT verified here is that the real model loads; `cognis doctor` is how you
 * check that on a machine with access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TransformersEmbedder, EmbedderUnavailableError, DEFAULT_DIM,
} from '../src/adapters/transformers-embedder.js';
import type { PipelineFactory } from '../src/adapters/transformers-embedder.js';

/** A stand-in model: deterministic, correct shape, records how it was called. */
function fakeFactory(dim = DEFAULT_DIM) {
  const calls: string[][] = [];
  const factory: PipelineFactory = async () => async (texts) => {
    calls.push([...texts]);
    const data = new Float32Array(texts.length * dim);
    texts.forEach((text, i) => {
      for (let j = 0; j < dim; j++) {
        data[i * dim + j] = ((text.charCodeAt(j % text.length) || 1) % 17) / 17;
      }
    });
    return { data, dims: [texts.length, dim] };
  };
  return { factory, calls };
}

test('produces one vector per input, at the declared dimension', async () => {
  const { factory } = fakeFactory();
  const embedder = new TransformersEmbedder({ cacheDir: '/tmp/x', pipelineFactory: factory });

  const vectors = await embedder.embed(['alpha', 'beta', 'gamma']);
  assert.equal(vectors.length, 3);
  for (const v of vectors) assert.equal(v.length, DEFAULT_DIM);
});

test('batches instead of sending the whole corpus in one forward pass', async () => {
  const { factory, calls } = fakeFactory();
  const embedder = new TransformersEmbedder({
    cacheDir: '/tmp/x', pipelineFactory: factory, batchSize: 4,
  });

  const texts = Array.from({ length: 10 }, (_, i) => `text ${i}`);
  const vectors = await embedder.embed(texts);

  assert.equal(vectors.length, 10);
  assert.deepEqual(calls.map((c) => c.length), [4, 4, 2]);
  // Order must survive batching, or vectors get attached to the wrong chunks.
  assert.deepEqual(calls.flat(), texts);
});

test('the model id records the model and dimension together', () => {
  const embedder = new TransformersEmbedder({
    cacheDir: '/tmp/x', model: 'Xenova/all-MiniLM-L6-v2',
  });
  assert.equal(embedder.modelId, 'Xenova/all-MiniLM-L6-v2@384');
  // Vectors from different models are not comparable, and the stored id is
  // what makes a mismatch visible in the data rather than only in a crash.
  assert.ok(embedder.modelId.includes('384'));
});

test('a dimension mismatch is refused, not silently stored', async () => {
  const { factory } = fakeFactory(128);
  const embedder = new TransformersEmbedder({
    cacheDir: '/tmp/x', dim: 384, pipelineFactory: factory,
  });

  await assert.rejects(
    embedder.embed(['anything']),
    /produced 128-dimensional vectors but this embedder is configured for 384/,
  );
});

test('a truncated batch from the model is refused', async () => {
  const short: PipelineFactory = async () => async () => ({
    data: new Float32Array(DEFAULT_DIM),
    dims: [1, DEFAULT_DIM],
  });
  const embedder = new TransformersEmbedder({
    cacheDir: '/tmp/x', pipelineFactory: short,
  });
  await assert.rejects(
    embedder.embed(['one', 'two', 'three']),
    /returned 1 vectors for 3 inputs/,
  );
});

test('an unavailable model explains the remedy rather than stack-tracing', async () => {
  const exploding: PipelineFactory = async () => {
    throw new Error('ENOTFOUND huggingface.co');
  };
  const embedder = new TransformersEmbedder({
    cacheDir: '/tmp/models', pipelineFactory: exploding,
  });

  await assert.rejects(embedder.embed(['x']), (err: unknown) => {
    assert.ok(err instanceof EmbedderUnavailableError);
    assert.match(err.message, /ENOTFOUND huggingface.co/);
    assert.match(err.message, /\/tmp\/models/, 'says where weights are looked for');
    assert.match(err.message, /--offline/, 'says how to run without the network');
    return true;
  });
});

test('embedding nothing does not load the model', async () => {
  let loaded = false;
  const factory: PipelineFactory = async () => {
    loaded = true;
    return async () => ({ data: new Float32Array(0), dims: [0, DEFAULT_DIM] });
  };
  const embedder = new TransformersEmbedder({ cacheDir: '/tmp/x', pipelineFactory: factory });

  assert.deepEqual(await embedder.embed([]), []);
  assert.equal(loaded, false, 'an empty batch should not pay to load 23MB of weights');
});

test('the model loads once across many calls', async () => {
  let loads = 0;
  const factory: PipelineFactory = async () => {
    loads++;
    return async (texts) => ({
      data: new Float32Array(texts.length * DEFAULT_DIM),
      dims: [texts.length, DEFAULT_DIM],
    });
  };
  const embedder = new TransformersEmbedder({ cacheDir: '/tmp/x', pipelineFactory: factory });

  await embedder.embed(['a']);
  await embedder.embed(['b']);
  await embedder.embed(['c']);
  assert.equal(loads, 1);
});
