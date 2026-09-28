/**
 * platform/ids.ts
 */
import { randomUUID } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '')}`;

export const idGen = {
  agent: () => newId('agt'),
  memory: () => newId('mem'),
  project: () => newId('prj'),
  member: () => newId('pmb'),
  task: () => newId('tsk'),
  dependency: () => newId('dep'),
  execution: () => newId('exe'),
  statusLog: () => newId('slg'),
  toolAudit: () => newId('aud'),
};
