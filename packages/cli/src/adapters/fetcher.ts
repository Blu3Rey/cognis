/**
 * HTTP fetching for ingestion.
 *
 * Deliberately conservative: a descriptive user agent, a timeout, a size cap,
 * and a refusal to follow a redirect chain forever. The corpus is built from
 * other people's servers, and a reading tool has no business being rude to
 * them.
 */

export const USER_AGENT =
  'cognis/0.0.1 (personal knowledge manager; +https://github.com/Blu3Rey/cognis)';

export interface FetchOptions {
  timeoutMs?: number;
  /** Refuse anything larger. Articles are small; a 200MB response is a mistake. */
  maxBytes?: number;
  userAgent?: string;
}

export interface FetchedDocument {
  /** URL after redirects. This is what identity is derived from. */
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: string;
  bytes: number;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

/** Content types we can extract from. Anything else is an honest failure. */
const TEXTUAL = [
  'text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown',
  'application/xml', 'text/xml',
];

export async function fetchDocument(
  url: string,
  opts: FetchOptions = {},
): Promise<FetchedDocument> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': opts.userAgent ?? USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.message : String(err);
    throw new FetchError(
      controller.signal.aborted ? `timed out after ${timeoutMs}ms` : reason,
      url,
    );
  }
  clearTimeout(timer);

  if (!response.ok) {
    // A paywall or a bot wall is a normal outcome, not an exception the user
    // needs to see a stack trace for. The caller records it as a failed
    // extraction and keeps the attested capture.
    throw new FetchError(
      `HTTP ${response.status} ${response.statusText}`,
      url,
      response.status,
    );
  }

  const contentType = response.headers.get('content-type');
  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime && !TEXTUAL.includes(mime)) {
    throw new FetchError(
      `unsupported content type ${mime} (PDF ingestion is not implemented yet; ` +
        `save the file and use \`cognis ingest <path>\`)`,
      url,
      response.status,
    );
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new FetchError(
      `response is ${declared} bytes, over the ${maxBytes} limit`,
      url,
      response.status,
    );
  }

  const body = await response.text();
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > maxBytes) {
    throw new FetchError(`response is ${bytes} bytes, over the ${maxBytes} limit`, url);
  }

  return {
    finalUrl: response.url || url,
    status: response.status,
    contentType,
    body,
    bytes,
  };
}
