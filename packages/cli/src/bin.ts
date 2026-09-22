#!/usr/bin/env node
/**
 * Entry point.
 *
 * Deliberately thin. `node:sqlite` is marked experimental and Node prints a
 * warning the moment it is imported — on every single invocation, before any
 * of the CLI's own output. ES module imports are hoisted and evaluated before
 * the importing module's body runs, so the filter has to be installed here and
 * the real program pulled in dynamically afterwards.
 *
 * Only that one known, harmless warning is suppressed. Anything else still
 * reaches the user.
 */

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

await import('./main.js');
