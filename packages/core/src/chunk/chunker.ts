/**
 * Chunking.
 *
 * docs/08 notes that chunking strategy affects retrieval quality more than the
 * choice of embedding model, so this is deliberately structural rather than a
 * fixed-width slicer: it splits on headings first, then paragraphs, and only
 * falls back to sentence boundaries when a paragraph exceeds the budget.
 *
 * Two properties are load-bearing downstream:
 *
 *  - `startChar`/`endChar` are absolute offsets into the document version's
 *    text. Quiz-item evidence spans and citation anchoring depend on them, so
 *    they must survive re-chunking unchanged for unchanged text.
 *  - The function is pure and deterministic given its options, so re-chunking
 *    is a scoped rebuild rather than a migration.
 */

export interface ChunkOptions {
  /** Soft upper bound in characters. Paragraphs are kept whole below it. */
  targetChars?: number;
  /** A chunk shorter than this is merged forward rather than emitted alone. */
  minChars?: number;
  /** Trailing context repeated into the next chunk, for boundary continuity. */
  overlapChars?: number;
}

export const CHUNKER_VERSION = '1.0.0';

const DEFAULTS = {
  targetChars: 1200,
  minChars: 200,
  overlapChars: 120,
} as const;

export interface TextChunk {
  ordinal: number;
  startChar: number;
  endChar: number;
  text: string;
  /** Heading breadcrumb, e.g. "3. Methods > 3.2 Sampling". Null at top level. */
  sectionPath: string | null;
}

interface Block {
  start: number;
  end: number;
  text: string;
  heading: { level: number; title: string } | null;
}

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/** "3.", "3.2", "IV." — numbered section headings in extracted prose. */
const NUMBERED_HEADING = /^((?:\d+\.){1,3}\d*|[IVXLC]+\.)\s+(\S.{0,80})$/;

function classifyHeading(line: string): { level: number; title: string } | null {
  const md = MD_HEADING.exec(line);
  if (md?.[1] && md[2]) return { level: md[1].length, title: md[2] };

  const num = NUMBERED_HEADING.exec(line.trim());
  if (num?.[1] && num[2]) {
    // Depth from the numbering: "3." is level 1, "3.2" level 2.
    const depth = (num[1].match(/\./g) ?? []).length;
    return { level: Math.max(1, depth), title: line.trim() };
  }

  // A short standalone line in title case, with no terminal punctuation, is
  // very likely a heading in extracted article text.
  const t = line.trim();
  if (t.length > 0 && t.length <= 80 && !/[.!?;:,]$/.test(t)) {
    const words = t.split(/\s+/);
    if (words.length <= 10 && /^[A-Z0-9]/.test(t) && t === t.replace(/\s{2,}/g, ' ')) {
      const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
      if (capitalised / words.length >= 0.6) return { level: 2, title: t };
    }
  }
  return null;
}

/** Split text into paragraph/heading blocks carrying absolute offsets. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let offset = 0;
  // Split on blank lines, preserving offsets by walking the original string.
  const parts = text.split(/(\n[ \t]*\n)/);
  for (const part of parts) {
    if (/^\n[ \t]*\n$/.test(part)) {
      offset += part.length;
      continue;
    }
    if (part.trim()) {
      // A block of consecutive lines may still open with a heading line.
      const lines = part.split('\n');
      let lineOffset = offset;
      let pending: { start: number; text: string } | null = null;

      const flush = (end: number) => {
        if (pending && pending.text.trim()) {
          blocks.push({
            start: pending.start,
            end,
            text: pending.text,
            heading: null,
          });
        }
        pending = null;
      };

      for (const line of lines) {
        const heading = classifyHeading(line);
        if (heading) {
          flush(lineOffset);
          blocks.push({
            start: lineOffset,
            end: lineOffset + line.length,
            text: line,
            heading,
          });
        } else {
          if (!pending) pending = { start: lineOffset, text: line };
          else pending.text += '\n' + line;
        }
        lineOffset += line.length + 1; // +1 for the consumed newline
      }
      flush(Math.min(lineOffset, offset + part.length));
    }
    offset += part.length;
  }
  return blocks;
}

/** Sentence-boundary split used only when one paragraph exceeds the budget. */
function splitLong(block: Block, targetChars: number): Block[] {
  const out: Block[] = [];
  const re = /[^.!?]+[.!?]+[\])'"`]*\s*|[^.!?]+$/g;
  let buf = '';
  let bufStart = block.start;
  let cursor = block.start;

  const sentences = block.text.match(re) ?? [block.text];
  for (const s of sentences) {
    if (buf && buf.length + s.length > targetChars) {
      out.push({ start: bufStart, end: bufStart + buf.length, text: buf, heading: null });
      bufStart = cursor;
      buf = '';
    }
    buf += s;
    cursor += s.length;
  }
  if (buf.trim()) {
    out.push({ start: bufStart, end: bufStart + buf.length, text: buf, heading: null });
  }
  return out;
}

export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const targetChars = opts.targetChars ?? DEFAULTS.targetChars;
  const minChars = opts.minChars ?? DEFAULTS.minChars;
  const overlapChars = opts.overlapChars ?? DEFAULTS.overlapChars;

  const blocks = toBlocks(text);
  const chunks: TextChunk[] = [];
  const headingStack: { level: number; title: string }[] = [];

  let current: { start: number; end: number; text: string; path: string | null } | null = null;

  const pathNow = (): string | null =>
    headingStack.length ? headingStack.map((h) => h.title).join(' > ') : null;

  const emit = () => {
    if (!current || !current.text.trim()) {
      current = null;
      return;
    }
    chunks.push({
      ordinal: chunks.length,
      startChar: current.start,
      endChar: current.end,
      text: current.text.trim(),
      sectionPath: current.path,
    });
    current = null;
  };

  for (const block of blocks) {
    if (block.heading) {
      // A heading closes the preceding chunk: sections are the natural seam.
      emit();
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1]!.level >= block.heading.level
      ) {
        headingStack.pop();
      }
      headingStack.push(block.heading);
      continue;
    }

    const pieces =
      block.text.length > targetChars ? splitLong(block, targetChars) : [block];

    for (const piece of pieces) {
      if (!current) {
        current = {
          start: piece.start,
          end: piece.end,
          text: piece.text,
          path: pathNow(),
        };
        continue;
      }
      if (current.text.length + piece.text.length <= targetChars) {
        current.text += '\n\n' + piece.text;
        current.end = piece.end;
      } else {
        const prevTail = current.text.slice(-overlapChars);
        emit();
        current = {
          start: piece.start,
          end: piece.end,
          // Overlap gives the embedder boundary context without moving the
          // recorded offsets, which stay anchored to the real span.
          text: overlapChars > 0 ? prevTail + '\n\n' + piece.text : piece.text,
          path: pathNow(),
        };
      }
    }
  }
  emit();

  // Merge a runt tail chunk backwards: a 30-character fragment embeds badly
  // and pollutes both novelty and search.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1]!;
    const prev = chunks[chunks.length - 2]!;
    if (last.text.length < minChars && last.sectionPath === prev.sectionPath) {
      prev.text = prev.text + '\n\n' + last.text;
      prev.endChar = last.endChar;
      chunks.pop();
    }
  }

  return chunks;
}
