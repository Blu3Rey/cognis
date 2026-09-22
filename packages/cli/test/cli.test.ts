/**
 * End-to-end through the real CLI binary: a real HTTP server, real HTML, real
 * extraction, real SQLite on disk. The embedder is the lexical fallback,
 * because model weights are not available in every environment — but every
 * other layer here is the production path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'src', 'bin.js');

function article(title: string, paragraphs: string[]): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title>
    <link rel="canonical" href="/a/${encodeURIComponent(title)}"></head>
    <body><nav>site nav</nav><article><h1>${title}</h1>
    ${paragraphs.map((p) => `<p>${p}</p>`).join('')}
    </article><footer>footer junk</footer></body></html>`;
}

const SPACING = article('Spaced repetition', [
  'Spaced repetition schedules reviews at expanding intervals, which produces markedly more durable retention than massing the same practice into a single session.',
  'The finding replicates across verbal learning, motor skills and classroom instruction, and holds for both children and adults in controlled comparisons.',
  'Each successful retrieval strengthens the memory trace, so the technique both measures and improves what it is testing at the same time.',
]);

const BREAD = article('Sourdough fermentation', [
  'Sourdough fermentation relies on wild yeast and lactic acid bacteria working together over many hours to develop both flavour and structure in the dough.',
  'Hydration ratio and ambient temperature govern the crumb, and small changes in either produce noticeably different results in the finished loaf.',
  'Patience matters more than precision, since the culture responds to conditions rather than to the baker following a fixed schedule exactly.',
]);

async function withFixture(
  fn: (ctx: { url: string; home: string; run: (...args: string[]) => Promise<{ stdout: string; stderr: string; code: number }> }) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/spacing')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SPACING);
    } else if (req.url?.startsWith('/bread')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(BREAD);
    } else if (req.url?.startsWith('/paywall')) {
      res.writeHead(402, { 'content-type': 'text/html' });
      res.end('<html><body>Subscribe to continue</body></html>');
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const home = await mkdtemp(join(tmpdir(), 'cognis-cli-'));

  const run = async (...args: string[]) => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
        env: { ...process.env, COGNIS_HOME: home, NO_COLOR: '1', NO_PROXY: '127.0.0.1' },
        maxBuffer: 20 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
    }
  };

  try {
    await fn({ url: `http://127.0.0.1:${port}`, home, run });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}

test('ingests a real page end to end and reports what happened', async () => {
  await withFixture(async ({ url, run }) => {
    const res = await run('ingest', `${url}/spacing`, '--embedder', 'hash', '--json');
    assert.equal(res.code, 0, res.stderr);

    const [result] = JSON.parse(res.stdout) as {
      extracted: boolean; wordCount: number; chunks: number; indexed: boolean;
      title: string; reEncounter: boolean;
    }[];

    assert.equal(result!.extracted, true);
    assert.ok(result!.wordCount > 60, `expected real content, got ${result!.wordCount} words`);
    assert.equal(result!.indexed, true);
    assert.ok(result!.chunks > 0);
    assert.match(result!.title, /Spaced repetition/);
    assert.equal(result!.reEncounter, false);
  });
});

test('a paywall is recorded as a failure, and the capture survives it', async () => {
  await withFixture(async ({ url, run }) => {
    const res = await run('ingest', `${url}/paywall`, '--embedder', 'hash', '--json');
    // Non-zero exit, because the user should know extraction failed.
    assert.equal(res.code, 1);

    const [result] = JSON.parse(res.stdout) as {
      extracted: boolean; failureReason: string; sourceId: string;
    }[];
    assert.equal(result!.extracted, false);
    assert.match(result!.failureReason, /402/);

    // The attested record must survive the parser's failure (docs/03).
    const list = await run('list', '--json');
    const rows = JSON.parse(list.stdout) as { status: string; sourceId: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'extraction_failed');
    assert.equal(rows[0]!.sourceId, result!.sourceId);
  });
});

test('re-ingesting the same URL appends an encounter, not a second source', async () => {
  await withFixture(async ({ url, run }) => {
    await run('ingest', `${url}/spacing`, '--embedder', 'hash');
    const second = await run('ingest', `${url}/spacing`, '--embedder', 'hash', '--json');

    const [result] = JSON.parse(second.stdout) as { reEncounter: boolean; priorEvents: number }[];
    assert.equal(result!.reEncounter, true, 're-reading is the signal, not a duplicate');
    assert.ok(result!.priorEvents >= 1);

    const stats = JSON.parse((await run('stats', '--json')).stdout) as {
      sources: number; events: number;
    };
    assert.equal(stats.sources, 1);
    assert.equal(stats.events, 2);
  });
});

test('search finds the right document among several', async () => {
  await withFixture(async ({ url, run }) => {
    await run('ingest', `${url}/spacing`, `${url}/bread`, '--embedder', 'hash');

    const res = await run('search', 'yeast bacteria dough', '--embedder', 'hash', '--json');
    assert.equal(res.code, 0, res.stderr);
    const hits = JSON.parse(res.stdout) as { sourceTitle: string; score: number }[];

    assert.ok(hits.length > 0, 'expected hits');
    assert.match(hits[0]!.sourceTitle, /Sourdough/);
  });
});

test('novelty is reported once there is something to compare against', async () => {
  await withFixture(async ({ url, run }) => {
    const first = JSON.parse(
      (await run('ingest', `${url}/spacing`, '--embedder', 'hash', '--json')).stdout,
    ) as { noveltyComparable: boolean }[];
    assert.equal(first[0]!.noveltyComparable, false, 'nothing to compare against yet');

    const second = JSON.parse(
      (await run('ingest', `${url}/bread`, '--embedder', 'hash', '--json')).stdout,
    ) as { noveltyComparable: boolean; novelty: number }[];
    assert.equal(second[0]!.noveltyComparable, true);
    assert.ok(second[0]!.novelty! > 0 && second[0]!.novelty! <= 1);
  });
});

test('doctor reports the real setup and flags mixed models', async () => {
  await withFixture(async ({ url, run }) => {
    await run('ingest', `${url}/spacing`, '--embedder', 'hash');

    const ok = await run('doctor', '--embedder', 'hash', '--json');
    const report = JSON.parse(ok.stdout) as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.ok(report.checks.some((c) => c.name === 'vector consistency' && c.ok));
  });
});

test('mixing embedding models is refused rather than silently corrupting the corpus', async () => {
  await withFixture(async ({ url, run }) => {
    await run('ingest', `${url}/spacing`, '--embedder', 'hash');

    // A different model produces vectors that are not comparable with the
    // ones already stored. Proceeding would make novelty and search lie.
    const res = await run('ingest', `${url}/bread`, '--embedder', 'transformers', '--offline');
    assert.equal(res.code, 1);
    assert.match(res.stderr, /already holds vectors from a different model/);
    assert.match(res.stderr, /reindex --all/);
  });
});

test('export and import round-trip through the CLI', async () => {
  await withFixture(async ({ url, run, home }) => {
    await run('ingest', `${url}/spacing`, `${url}/bread`, '--embedder', 'hash');
    const path = join(home, 'export.jsonl');

    const exported = await run('export', path);
    assert.equal(exported.code, 0, exported.stderr);
    const content = await readFile(path, 'utf8');
    assert.ok(content.split('\n').filter(Boolean).length > 3);

    const header = JSON.parse(content.split('\n')[0]!) as { format: string };
    assert.equal(header.format, 'cognis-jsonl');
  });
});

test('privacy controls are reachable and honest from the CLI', async () => {
  await withFixture(async ({ url, run }) => {
    const ingested = JSON.parse(
      (await run('ingest', `${url}/spacing`, '--embedder', 'hash', '--json')).stdout,
    ) as { sourceId: string }[];

    const check = JSON.parse(
      (await run('privacy', 'check', 'https://mail.google.com/inbox', '--json')).stdout,
    ) as { isPrivate: boolean; reason: string };
    assert.equal(check.isPrivate, true);
    assert.ok(check.reason);

    const set = await run('privacy', 'set', ingested[0]!.sourceId, '--private');
    assert.equal(set.code, 0, set.stderr);

    const shown = JSON.parse(
      (await run('show', ingested[0]!.sourceId, '--json')).stdout,
    ) as { isPrivate: boolean };
    assert.equal(shown.isPrivate, true);
  });
});

test('help works and unknown commands fail loudly', async () => {
  await withFixture(async ({ run }) => {
    const help = await run('help');
    assert.equal(help.code, 0);
    assert.match(help.stdout, /ingest/);
    assert.match(help.stdout, /COGNIS_HOME/);

    const bad = await run('frobnicate');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /unknown command/);
  });
});
