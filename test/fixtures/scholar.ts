import type { FixtureWork } from '../../src/adapters/fixture-scholar-graph.js';

/**
 * A small citation graph. Three papers the user reads all cite
 * 10.1111/foundational — which none of them holds. That convergence is the
 * flagship suggestion signal, and it is a fact rather than a guess.
 */
export const WORKS: FixtureWork[] = [
  {
    doi: '10.1234/spacing', title: 'Spacing effects in learning',
    authors: ['Cepeda'], publishedYear: 2006, openAccess: true, citedByCount: 900,
    references: ['10.1111/foundational', '10.2222/ebbinghaus'],
  },
  {
    doi: '10.1234/testing', title: 'The critical importance of retrieval',
    authors: ['Karpicke'], publishedYear: 2008, openAccess: true, citedByCount: 1200,
    references: ['10.1111/foundational', '10.3333/bjork'],
  },
  {
    doi: '10.1234/interleaving', title: 'Interleaving in category learning',
    authors: ['Kornell'], publishedYear: 2008, openAccess: false, citedByCount: 400,
    references: ['10.1111/foundational', '10.3333/bjork'],
  },
  {
    doi: '10.1111/foundational', title: 'A foundational account of memory',
    authors: ['Bjork'], publishedYear: 1994, openAccess: true, citedByCount: 5000,
  },
  {
    doi: '10.3333/bjork', title: 'Desirable difficulties',
    authors: ['Bjork'], publishedYear: 1994, openAccess: false, citedByCount: 3000,
  },
  {
    doi: '10.2222/ebbinghaus', title: 'Memory: a contribution to experimental psychology',
    authors: ['Ebbinghaus'], publishedYear: 1885, openAccess: true, citedByCount: 8000,
  },
];
