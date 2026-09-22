/**
 * cognis — a real client for the core library.
 *
 * Its job is to get actual reading through the actual pipeline, so the
 * fixtures the core test suite runs against stop being the only thing the code
 * has ever seen. It is also the scripting surface for the two evaluations that
 * are still unrun.
 */

import { parseArgs, flagString, flagBool, flagNumber } from './args.js';
import { openCognis, assertEmbedderConsistent } from './context.js';
import type { EmbedderChoice, OpenOptions } from './context.js';
import { ingestOne } from './commands/ingest.js';
import { indexPending } from './commands/index-cmd.js';
import {
  corpusStats, sourceDetail, recentCaptures, doctor,
} from './commands/report.js';
import { linkCorpus, coverageGaps, topConcepts } from './commands/link.js';
import {
  info, success, warn, fail, json, pairs, table, bold, dim, green, yellow,
  ellipsis, relativeTime,
} from './output.js';

const HELP = `${bold('cognis')} — personal knowledge management, on your own corpus

${bold('USAGE')}
  cognis <command> [options]

${bold('CAPTURE')}
  ingest <url|file>...        Fetch, extract, store and index
  index [--all]               Chunk and embed anything not yet indexed
  reindex --all               Re-chunk and re-embed everything (after a model change)

${bold('CONCEPTS')}  ${dim('(these cost money — see --dry-run)')}
  link [--all]                Resolve concepts via Wikidata + Claude, roll up coverage
  concepts [--limit N]        What the corpus is about
  gaps [--min-sources N]      Met from several sources, never covered directly

${bold('READ')}
  list [--limit N]            Recent captures
  show <sourceId>             Everything known about one source
  search <query>              Semantic search (--literal for substring)
  stats                       Corpus summary
  doctor                      Check the setup before trusting it

${bold('PRIVACY')}
  privacy log [--limit N]     Everything that has left this device
  privacy set <id> --private  Exclude a source from all egress
  privacy set <id> --public   Allow it again
  privacy check <url>         How a URL would be classified, without capturing

${bold('DATA')}
  export <path>               Full JSONL export
  import <path>               Import a JSONL export into an empty corpus

${bold('OPTIONS')}
  --embedder <transformers|hash|none>   Default: transformers
  --model <id>                          Default: Xenova/all-MiniLM-L6-v2
  --offline                             Never fetch model weights
  --json                                Machine-readable output
  --no-index                            Capture and extract without embedding
  --linker-model <id>                   Default: claude-opus-5
  --effort <low|medium|high|xhigh|max>  Linker effort. Default: low
  --dry-run                             Show what link would process, spend nothing
  --min-words N                         Short-document floor (fetched pages default 50)
  --private                             Force a capture private

${bold('ENVIRONMENT')}
  COGNIS_HOME     Data directory (default ~/.cognis)
  COGNIS_DB       Database path
  COGNIS_MODELS   Model weight cache
`;

function embedderChoice(value: string | undefined): EmbedderChoice {
  if (value === undefined) return 'transformers';
  if (value === 'transformers' || value === 'hash' || value === 'none') return value;
  throw new Error(`--embedder must be transformers, hash or none (got "${value}")`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const asJson = flagBool(args.flags, 'json');

  if (!args.command || args.command === 'help' || flagBool(args.flags, 'help')) {
    info(HELP);
    return 0;
  }

  const openOpts: OpenOptions = {
    embedder: embedderChoice(flagString(args.flags, 'embedder')),
    ...(flagString(args.flags, 'model') ? { model: flagString(args.flags, 'model')! } : {}),
    offline: flagBool(args.flags, 'offline'),
  };

  // Linking needs a vocabulary and a linker; nothing else should construct a
  // network client or an API key requirement it will not use.
  if (args.command === 'link') {
    openOpts.linking = !flagBool(args.flags, 'dry-run');
    const model = flagString(args.flags, 'linker-model');
    if (model) openOpts.linkerModel = model;
    const effort = flagString(args.flags, 'effort');
    if (effort) {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
        throw new Error(`--effort must be low, medium, high, xhigh or max (got "${effort}")`);
      }
      openOpts.linkerEffort = effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    }
    openOpts.embedder = 'none';
  }

  // Commands that never touch an embedder should not pay to construct one.
  const readOnly = ['list', 'show', 'stats', 'privacy', 'export', 'import', 'concepts', 'gaps'];
  if (readOnly.includes(args.command) && !args.flags.has('embedder')) {
    openOpts.embedder = 'none';
  }
  if (args.command === 'search' && flagBool(args.flags, 'literal')) {
    openOpts.embedder = 'none';
  }

  const ctx = await openCognis(openOpts);

  try {
    switch (args.command) {
      case 'ingest': {
        const targets = args.positionals;
        if (targets.length === 0) throw new Error('ingest needs at least one URL or file');
        if (!flagBool(args.flags, 'no-index')) await assertEmbedderConsistent(ctx);

        const results = [];
        for (const target of targets) {
          const result = await ingestOne(ctx.cognis, target, {
            noIndex: flagBool(args.flags, 'no-index'),
            private: flagBool(args.flags, 'private'),
            ...(args.flags.has('min-words')
              ? { minWords: flagNumber(args.flags, 'min-words', 50) }
              : {}),
          });
          results.push(result);

          if (asJson) continue;

          if (!result.extracted) {
            fail(`${target}\n  ${dim(result.failureReason ?? 'extraction failed')}`);
            info(dim('  the capture is still recorded; re-run later to retry extraction'));
            continue;
          }

          success(bold(result.title ?? target));
          const detail: [string, string | number | null][] = [
            ['words', result.wordCount],
            ['chunks', result.indexed ? result.chunks : dim('not indexed')],
          ];
          if (result.reEncounter) {
            detail.push(['seen before', `yes — ${result.priorEvents} earlier encounter(s)`]);
          }
          if (result.noveltyComparable && result.novelty !== null) {
            const pct = (result.novelty * 100).toFixed(0);
            detail.push([
              'novelty',
              result.novelty < 0.3
                ? `${yellow(pct + '%')} — close to something you already have`
                : `${green(pct + '%')}`,
            ]);
          } else if (result.indexed) {
            detail.push(['novelty', dim('nothing to compare against yet')]);
          }
          if (result.isPrivate) {
            detail.push(['private', result.privateReason ?? 'yes']);
          }
          pairs(detail);
        }

        if (asJson) json(results);
        return results.every((r) => r.extracted) ? 0 : 1;
      }

      case 'index':
      case 'reindex': {
        await assertEmbedderConsistent(ctx);
        const all = args.command === 'reindex' || flagBool(args.flags, 'all');
        const report = await indexPending(ctx.cognis, {
          all,
          limit: flagNumber(args.flags, 'limit', 1000),
        });
        if (asJson) { json(report); return report.failures.length ? 1 : 0; }

        success(`indexed ${report.indexed}/${report.considered} documents, ${report.chunks} chunks`);
        for (const f of report.failures) fail(`${f.documentVersionId}: ${f.reason}`);
        return report.failures.length ? 1 : 0;
      }

      case 'link': {
        const all = flagBool(args.flags, 'all');
        const limit = flagNumber(args.flags, 'limit', 500);

        if (flagBool(args.flags, 'dry-run')) {
          const pending = await ctx.cognis.db.all<{ n: number }>(
            `SELECT COUNT(*) AS n FROM document_version dv
               JOIN source s ON s.id = dv.source_id
              WHERE COALESCE(s.is_private, 0) = 0
                AND (? = 1 OR NOT EXISTS (
                      SELECT 1 FROM mention m JOIN chunk c ON c.id = m.chunk_id
                       WHERE c.document_version_id = dv.id))`,
            [all ? 1 : 0],
          );
          const chunks = await ctx.cognis.db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM chunk',
          );
          const docs = pending[0]?.n ?? 0;
          info(`${bold(String(docs))} document(s) would be linked, ~${chunks?.n ?? 0} chunks.`);
          info(dim('One model call per chunk. Nothing was sent and nothing was spent.'));
          return 0;
        }

        const report = await linkCorpus(ctx.cognis, ctx.linkerUsage, { all, limit });
        if (asJson) { json(report); return report.failed.length ? 1 : 0; }

        success(`linked ${report.linked}/${report.documents} documents`);
        pairs([
          ['mentions', report.mentions],
          ['anchored', report.anchored],
          ['NIL (no candidate fit)', report.nil],
          ['new local concepts', report.localConcepts],
          ['concepts in corpus', report.concepts],
          ['skipped (private)', report.skippedPrivate],
          ['cost', `$${report.cost.usd.toFixed(4)} (${report.cost.inputTokens} in, ` +
            `${report.cost.outputTokens} out, ${report.cost.cacheReadTokens} cached)`],
        ]);
        if (report.cost.refusals > 0) {
          warn(`${report.cost.refusals} chunk(s) were declined and linked as NIL`);
        }
        for (const f of report.failed) fail(`${f.documentVersionId}: ${f.reason}`);

        info('');
        warn(
          'coverage numbers built on these links are only as good as the linker, ' +
          'and its precision has not been measured against a labelled set yet (docs/12 §2)',
        );
        return report.failed.length ? 1 : 0;
      }

      case 'concepts': {
        const rows = await topConcepts(ctx.cognis, flagNumber(args.flags, 'limit', 30));
        if (asJson) { json(rows); return 0; }
        table(['PRIMARY', 'SOURCES', 'LABEL', 'ID'], rows.map((r) => [
          r.primarySources, r.distinctSources, ellipsis(r.label, 44), r.conceptId,
        ]));
        return 0;
      }

      case 'gaps': {
        const rows = await coverageGaps(ctx.cognis, {
          minSources: flagNumber(args.flags, 'min-sources', 2),
          limit: flagNumber(args.flags, 'limit', 25),
          includeLocal: flagBool(args.flags, 'include-local'),
        });
        if (asJson) { json(rows); return 0; }
        if (rows.length === 0) {
          info(dim('no gaps yet — link more of the corpus, or lower --min-sources'));
          return 0;
        }
        info(dim('met from several sources, never covered directly:\n'));
        table(['SOURCES', 'SPREAD', 'LABEL', 'ID'], rows.map((r) => [
          r.distinctSources, `${r.temporalSpreadDays}d`,
          ellipsis(r.label, 44), r.conceptId,
        ]));
        return 0;
      }

      case 'list': {
        const rows = await recentCaptures(ctx.cognis, flagNumber(args.flags, 'limit', 20));
        if (asJson) { json(rows); return 0; }
        table(
          ['WHEN', 'STATUS', 'TITLE', 'SOURCE'],
          rows.map((r) => [
            relativeTime(r.occurredAt),
            r.status === 'extraction_failed' ? 'failed' : r.status,
            ellipsis(r.title ?? '(untitled)', 52) + (r.isPrivate ? ' 🔒' : ''),
            r.sourceId.slice(0, 12),
          ]),
        );
        return 0;
      }

      case 'show': {
        const id = args.positionals[0];
        if (!id) throw new Error('show needs a source id (see `cognis list`)');
        const detail = await sourceDetail(ctx.cognis, id);
        if (!detail) { fail(`no such source: ${id}`); return 1; }
        if (asJson) { json(detail); return 0; }

        info(bold(detail.title ?? '(untitled)'));
        pairs([
          ['id', detail.id],
          ['url', detail.canonicalUrl],
          ['doi', detail.doi],
          ['kind', detail.kind],
          ['private', detail.isPrivate ? 'yes' : 'no'],
          ['first seen', relativeTime(detail.firstSeenAt)],
        ]);
        info('\n' + bold('encounters'));
        table(['WHEN', 'VIA', 'DEPTH', 'STATUS'], detail.events.map((e) => [
          relativeTime(e.occurredAt), e.capturePath, e.engagement ?? '—', e.status,
        ]));
        if (detail.concepts.length > 0) {
          info('\n' + bold('concepts'));
          table(['PRIMARY', 'LABEL', 'ID'], detail.concepts.map((c) => [
            c.isPrimary ? 'yes' : '', c.label, c.conceptId,
          ]));
        }
        return 0;
      }

      case 'search': {
        const query = args.positionals.join(' ').trim();
        if (!query) throw new Error('search needs a query');
        const limit = flagNumber(args.flags, 'limit', 10);
        const hits = flagBool(args.flags, 'literal')
          ? await ctx.cognis.searchLiteral(query, { limit })
          : await ctx.cognis.search(query, { limit });

        if (asJson) { json(hits); return 0; }
        if (hits.length === 0) { info(dim('no matches')); return 0; }

        for (const hit of hits) {
          info(
            `${bold(hit.score.toFixed(3))}  ${ellipsis(hit.sourceTitle ?? '(untitled)', 60)}`,
          );
          if (hit.sectionPath) info(`        ${dim(hit.sectionPath)}`);
          info(`        ${ellipsis(hit.text, 150)}`);
          info(`        ${dim(hit.sourceId.slice(0, 12))}\n`);
        }
        return 0;
      }

      case 'stats': {
        const stats = await corpusStats(ctx.cognis);
        if (asJson) { json(stats); return 0; }
        pairs([
          ['sources', stats.sources],
          ['encounters', stats.events],
          ['documents', stats.documents],
          ['words', stats.words.toLocaleString('en-US')],
          ['chunks', stats.chunks],
          ['concepts', stats.concepts],
          ['mentions', stats.mentions],
          ['private sources', stats.privateSources],
          ['failed extractions', stats.failedExtractions],
          ['egress calls', `${stats.egressCalls} (${stats.egressBytes.toLocaleString('en-US')} bytes)`],
          ['first capture', stats.firstCapture ? relativeTime(stats.firstCapture) : null],
          ['last capture', stats.lastCapture ? relativeTime(stats.lastCapture) : null],
        ]);
        if (stats.vectorsByModel.length > 0) {
          info('\n' + bold('vectors'));
          table(['MODEL', 'COUNT'], stats.vectorsByModel.map((v) => [v.modelId, v.vectors]));
          if (stats.vectorsByModel.length > 1) {
            warn('more than one embedding model in this corpus; run `cognis reindex --all`');
          }
        }
        return 0;
      }

      case 'doctor': {
        const report = await doctor(ctx.cognis, {
          dbPath: ctx.paths.dbPath,
          modelDir: ctx.paths.modelDir,
          embedderKind: ctx.embedderKind,
        });
        if (asJson) { json(report); return report.ok ? 0 : 1; }
        for (const c of report.checks) {
          info(`${c.ok ? green('✓') : yellow('!')} ${bold(c.name.padEnd(20))} ${c.detail}`);
        }
        return report.ok ? 0 : 1;
      }

      case 'privacy': {
        const sub = args.positionals[0];
        if (sub === 'log') {
          const entries = await ctx.cognis.egressLog({
            limit: flagNumber(args.flags, 'limit', 50),
          });
          if (asJson) { json(entries); return 0; }
          if (entries.length === 0) {
            info(dim('nothing has left this device'));
            return 0;
          }
          table(['WHEN', 'WHERE', 'WHY', 'BYTES', 'SOURCES'], entries.map((e) => [
            relativeTime(e.occurredAt), e.destination, e.purpose,
            e.bytesSent, e.sourceIds.length,
          ]));
          return 0;
        }
        if (sub === 'set') {
          const id = args.positionals[1];
          if (!id) throw new Error('privacy set needs a source id');
          const makePrivate = !flagBool(args.flags, 'public');
          await ctx.cognis.setSourcePrivate(id, makePrivate);
          success(`${id} is now ${makePrivate ? 'private' : 'public'}`);
          return 0;
        }
        if (sub === 'check') {
          const url = args.positionals[1];
          if (!url) throw new Error('privacy check needs a URL');
          const c = ctx.cognis.classifyUrl(url);
          if (asJson) { json(c); return 0; }
          info(c.isPrivate
            ? `${yellow('private')} — ${c.reason}`
            : `${green('public')} — no rule matched`);
          return 0;
        }
        throw new Error('privacy needs a subcommand: log, set or check');
      }

      case 'export': {
        const path = args.positionals[0];
        if (!path) throw new Error('export needs a destination path');
        const { createWriteStream } = await import('node:fs');
        const stream = createWriteStream(path, { encoding: 'utf8' });
        const { lines } = await ctx.cognis.exportAll((line) => {
          stream.write(line + '\n');
        });
        await new Promise<void>((resolve, reject) => {
          stream.end(() => resolve());
          stream.on('error', reject);
        });
        success(`exported ${lines} lines to ${path}`);
        return 0;
      }

      case 'import': {
        const path = args.positionals[0];
        if (!path) throw new Error('import needs a source path');
        const { readFile } = await import('node:fs/promises');
        const report = await ctx.cognis.importJsonlString(await readFile(path, 'utf8'));
        if (report.mismatches.length > 0) {
          fail('import completed with row-count mismatches:');
          json(report.mismatches);
          return 1;
        }
        success(`imported ${Object.values(report.imported).reduce((a, b) => a + b, 0)} rows`);
        info(dim('chunks and vectors are not exported; run `cognis index --all` to rebuild them'));
        return 0;
      }

      default:
        fail(`unknown command: ${args.command}`);
        info(HELP);
        return 1;
    }
  } finally {
    await ctx.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
