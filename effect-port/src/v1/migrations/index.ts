import { collaborationHandoffSql } from './003_collaboration_handoff.js';
import { coreSql } from './001_core.js';
import { workflowsSql } from './002_workflows.js';
import { nativeRuntimeSql } from './004_native_runtime.js';
import { artifactMediaTypeSql } from './005_artifact_media_type.js';
import { boardInboxSql } from './006_board_inbox.js';

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const migrations = [
  { version: 1, name: '001_core', sql: coreSql },
  { version: 2, name: '002_workflows', sql: workflowsSql },
  { version: 3, name: '003_collaboration_handoff', sql: collaborationHandoffSql },
  { version: 4, name: '004_native_runtime', sql: nativeRuntimeSql },
  { version: 5, name: '005_artifact_media_type', sql: artifactMediaTypeSql },
  { version: 6, name: '006_board_inbox', sql: boardInboxSql },
] satisfies readonly Migration[];
