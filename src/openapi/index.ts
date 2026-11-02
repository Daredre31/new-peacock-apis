import { registerAuthOperations } from '../modules/auth/auth.schema';
import { registerHealthOperations } from '../modules/health/health.schema';
import { buildDocument, type OpenApiDocument } from './builder';
import { OpenApiRegistry } from './registry';
import { registerAuditOperations } from '../modules/audit/audit.schema';
import { registerSessionOperations } from '../modules/academics/session.schema';
import { registerStructureOperations } from '../modules/academics/structure.schema';
import { ADMIN_STAFF_CONFIG, registerStaffOperations } from '../modules/users/staff.schema';
import { registerSecurityOperations } from '../modules/users/security.schema';
import { registerAssignmentOperations } from '../modules/academics/assignment.schema';
import { registerParentOperations } from '../modules/users/parent.schema';
import { TEACHER_STAFF_CONFIG } from '../modules/users/staff.schema';
import { registerStudentOperations } from '../modules/users/student.schema';
import { registerAnnouncementOperations } from '../modules/announcements/announcement.schema';
import { registerAttendanceOperations } from '../modules/attendance/attendance.schema';
import { registerNotificationOperations } from '../modules/notifications/notification.schema';
import { registerRequestOperations } from '../modules/requests/request.schema';
import { registerTaskOperations } from '../modules/tasks/task.schema';
import { registerSettingsOperations } from '../modules/settings/settings.schema';

/** Each phase adds its module's register function here. */
export function createOperationRegistry(): OpenApiRegistry {
  const registry = new OpenApiRegistry();
  registerHealthOperations(registry);
  registerAuthOperations(registry);
  registerAuditOperations(registry);
  registerSessionOperations(registry);
  registerStructureOperations(registry);
  registerStaffOperations(registry, ADMIN_STAFF_CONFIG);
  registerSecurityOperations(registry);
    registerStaffOperations(registry, TEACHER_STAFF_CONFIG);
  registerStudentOperations(registry);
  registerParentOperations(registry);
  registerAssignmentOperations(registry);
    registerNotificationOperations(registry);
  registerRequestOperations(registry);
  registerAnnouncementOperations(registry);
  registerAttendanceOperations(registry);
    registerTaskOperations(registry);
  registerSettingsOperations(registry);
  
  return registry;
}

export function buildOpenApiDocument(): OpenApiDocument {
  return buildDocument(createOperationRegistry());
}