import { Cognis } from '../src/core.js';
import { NodeSqliteDriver } from '../src/adapters/node-sqlite.js';
import { FakeClock } from '../src/ports/clock.js';

export async function freshCognis(start = '2026-01-01T00:00:00.000Z'): Promise<{
  cognis: Cognis;
  clock: FakeClock;
}> {
  const clock = new FakeClock(start);
  const cognis = new Cognis({ db: new NodeSqliteDriver(), clock });
  await cognis.migrate();
  return { cognis, clock };
}
