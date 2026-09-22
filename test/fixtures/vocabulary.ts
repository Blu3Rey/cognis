import type { FixtureConcept } from '../../src/adapters/fixture-vocabulary.js';

/**
 * A small gazetteer standing in for Wikidata. Ids follow the real prefixed
 * form so nothing in the pipeline depends on them being synthetic.
 */
export const VOCABULARY: FixtureConcept[] = [
  {
    id: 'wd:Q1049444', scheme: 'wikidata', label: 'Spaced repetition',
    description: 'Learning technique with increasing review intervals',
    aliases: ['spaced repetition', 'distributed practice', 'spacing effect'],
    parents: ['wd:Q1148747'],
  },
  {
    id: 'wd:Q7825195', scheme: 'wikidata', label: 'Testing effect',
    description: 'Retrieval practice improves long-term retention',
    aliases: ['testing effect', 'retrieval practice', 'active recall'],
    parents: ['wd:Q1148747'],
  },
  {
    id: 'wd:Q1148747', scheme: 'wikidata', label: 'Learning technique',
    description: 'Method for acquiring knowledge or skill',
    aliases: ['learning technique', 'study technique'],
    parents: ['wd:Q9081'],
  },
  {
    id: 'wd:Q9081', scheme: 'wikidata', label: 'Knowledge',
    description: 'Awareness of facts or practical skills',
    aliases: ['knowledge'],
  },
  {
    id: 'wd:Q1069', scheme: 'wikidata', label: 'Entity linking',
    description: 'Task of assigning identity to entity mentions in text',
    aliases: ['entity linking', 'entity resolution', 'named entity linking'],
    parents: ['wd:Q30642'],
  },
  {
    id: 'wd:Q30642', scheme: 'wikidata', label: 'Natural language processing',
    description: 'Field of computer science concerning language',
    aliases: ['natural language processing', 'NLP'],
  },
  {
    id: 'wd:Q160402', scheme: 'wikidata', label: 'Sourdough',
    description: 'Bread made by fermentation using naturally occurring lactobacilli',
    aliases: ['sourdough', 'sourdough fermentation'],
  },
  {
    id: 'wd:Q189302', scheme: 'wikidata', label: 'Interleaving',
    description: 'Mixing practice of different topics within a session',
    aliases: ['interleaving', 'interleaved practice'],
    parents: ['wd:Q1148747'],
  },
];
