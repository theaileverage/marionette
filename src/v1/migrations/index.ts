import { decisionsApprovalsSql } from './009_decisions_approvals.js';
import { projectHierarchySql } from './010_project_hierarchy.js';
import { controllerAuthoritySql } from './011_controller_authority.js';
import { workflowControlPlaneSql } from './008_workflow_control_plane.js';
import { harnessCatalogProfilesSql } from './007_harness_catalog_profiles.js';
import { serviceEventsControllerSql } from './006_service_events_controller.js';
import { collaborationHandoffSql } from './003_collaboration_handoff.js';
import { coreSql } from './001_core.js';
import { workflowsSql } from './002_workflows.js';
import { nativeRuntimeSql } from './004_native_runtime.js';
import { artifactMediaTypeSql } from './005_artifact_media_type.js';

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
  { version: 6, name: '006_service_events_controller', sql: serviceEventsControllerSql },
  { version: 7, name: '007_harness_catalog_profiles', sql: harnessCatalogProfilesSql },
  { version: 8, name: '008_workflow_control_plane', sql: workflowControlPlaneSql },
  { version: 9, name: '009_decisions_approvals', sql: decisionsApprovalsSql },
  { version: 10, name: '010_project_hierarchy', sql: projectHierarchySql },
  { version: 11, name: '011_controller_authority', sql: controllerAuthoritySql },
] satisfies readonly Migration[];
