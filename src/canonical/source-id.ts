/**
 * Deterministic source identity.
 *
 * A source's identity IS its DOI or canonical URL — not a random id minted by
 * whichever device saw it first. Two devices that read the same article must
 * arrive at the same source id independently, or sync collides on the unique
 * index over `canonical_url` and one device's copy is silently dropped.
 *
 * This is ADR-0005's argument applied one level down: identity comes from a
 * stable external property, so nothing has to be reconciled after the fact.
 *
 * A source with no natural key at all — an imported file with no URL, a pasted
 * note — falls back to a random id, which is correct: two such imports on two
 * devices genuinely are two separate things, and pretending otherwise would
 * merge unrelated material.
 */

import { sha256 } from './hash.js';
import { ulid } from '../ids.js';

export interface NaturalKey {
  doi?: string | null;
  canonicalUrl?: string | null;
  contentHash?: string | null;
}

/** Which key was used, so a later upgrade can be recognised. */
export type IdBasis = 'doi' | 'url' | 'content' | 'random';

export interface SourceIdentity {
  id: string;
  basis: IdBasis;
}

/**
 * Derive a source id.
 *
 * Ordered by stability: a DOI outranks a URL, which outranks a content hash.
 * The prefix records which basis was used, which makes an id self-describing
 * when debugging a merge.
 */
export async function sourceIdFor(key: NaturalKey): Promise<SourceIdentity> {
  if (key.doi) {
    return { id: `s-doi-${(await sha256(`doi:${key.doi}`)).slice(0, 24)}`, basis: 'doi' };
  }
  if (key.canonicalUrl) {
    return {
      id: `s-url-${(await sha256(`url:${key.canonicalUrl}`)).slice(0, 24)}`,
      basis: 'url',
    };
  }
  if (key.contentHash) {
    return {
      id: `s-cnt-${(await sha256(`content:${key.contentHash}`)).slice(0, 24)}`,
      basis: 'content',
    };
  }
  return { id: `s-loc-${ulid()}`, basis: 'random' };
}
