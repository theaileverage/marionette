import { collaborationHandoffSql } from './003_collaboration_handoff.js';
import { coreSql } from './001_core.js';
import { workflowsSql } from './002_workflows.js';

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const migrations = [
  { version: 1, name: '001_core', sql: coreSql },
  { version: 2, name: '002_workflows', sql: workflowsSql },
  { version: 3, name: '003_collaboration_handoff', sql: collaborationHandoffSql },
] satisfies readonly Migration[];
