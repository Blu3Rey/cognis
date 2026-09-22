import { Cognis } from '../src/core.js';
import { NodeSqliteDriver } from '../src/adapters/node-sqlite.js';
import { FakeClock } from '../src/ports/clock.js';
import { HashEmbedder } from '../src/adapters/hash-embedder.js';
import { FixtureVocabulary } from '../src/adapters/fixture-vocabulary.js';
import { RuleLinker } from '../src/adapters/rule-linker.js';
import { TemplateItemWriter } from '../src/adapters/template-item-writer.js';
import { KeywordGrader } from '../src/adapters/keyword-grader.js';
import { VOCABULARY } from './fixtures/vocabulary.js';

export async function freshCognis(start = '2026-01-01T00:00:00.000Z'): Promise<{
  cognis: Cognis;
  clock: FakeClock;
}> {
  const clock = new FakeClock(start);
  const cognis = new Cognis({
    db: new NodeSqliteDriver(),
    clock,
    embedder: new HashEmbedder(),
    vocabulary: new FixtureVocabulary(VOCABULARY),
    linker: new RuleLinker(),
    itemWriter: new TemplateItemWriter(),
    grader: new KeywordGrader(),
  });
  await cognis.migrate();
  return { cognis, clock };
}

/** Capture, extract and index one document in a single step. */
export async function ingest(
  cognis: Cognis,
  url: string,
  text: string,
  title?: string,
): Promise<{ sourceId: string; ingestionEventId: string; documentVersionId: string }> {
  const { textFingerprint } = await import('../src/canonical/hash.js');
  const cap = await cognis.capture({
    kind: 'url', payload: url, capturePath: 'share_sheet',
    ...(title === undefined ? {} : { title }),
  });
  const dv = await cognis.recordExtraction({
    sourceId: cap.sourceId,
    ingestionEventId: cap.ingestionEventId,
    text,
    textHash: await textFingerprint(text),
    producer: 'test-extractor',
    producerVersion: '1.0.0',
  });
  await cognis.indexDocument({
    documentVersionId: dv.documentVersionId,
    ingestionEventId: cap.ingestionEventId,
  });
  return {
    sourceId: cap.sourceId,
    ingestionEventId: cap.ingestionEventId,
    documentVersionId: dv.documentVersionId,
  };
}

/** Capture, extract, index, link and roll up coverage in one step. */
export async function ingestAndLink(
  cognis: Cognis,
  url: string,
  text: string,
  title: string,
): Promise<{ sourceId: string; ingestionEventId: string; documentVersionId: string }> {
  const res = await ingest(cognis, url, text, title);
  await cognis.linkDocument(res.documentVersionId);
  await cognis.rollupCoverage();
  return res;
}
