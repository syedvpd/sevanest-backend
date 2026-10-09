/**
 * Admin role names come from the PRD/SRS (FR-AUTH-004). Roles and permissions are DATA rows; these codes are the
 * stable keys the seed creates and the code refers to. Which role holds which permission is an OPEN decision (Q-11):
 * only SUPER_ADMIN is mapped, to the permissions the implemented modules need.
 */
export const AdminRoleCode = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  OPERATIONS_ADMIN: 'OPERATIONS_ADMIN',
  VERIFICATION_EXECUTIVE: 'VERIFICATION_EXECUTIVE',
  SUPPORT_EXECUTIVE: 'SUPPORT_EXECUTIVE',
} as const;

export type AdminRoleCodeValue = (typeof AdminRoleCode)[keyof typeof AdminRoleCode];

export const ADMIN_ROLE_CODES: readonly AdminRoleCodeValue[] = Object.values(AdminRoleCode);

export const ADMIN_ROLES: ReadonlyArray<{ code: AdminRoleCodeValue; name: string }> = [
  { code: AdminRoleCode.SUPER_ADMIN, name: 'Super Admin' },
  { code: AdminRoleCode.OPERATIONS_ADMIN, name: 'Operations Admin' },
  { code: AdminRoleCode.VERIFICATION_EXECUTIVE, name: 'Verification Executive' },
  { code: AdminRoleCode.SUPPORT_EXECUTIVE, name: 'Support Executive' },
];

/** Permission codes required by the implemented modules (nothing speculative). */
export const PermissionCode = {
  ADMIN_MANAGE_USERS: 'admin.manage_users',
  USER_VIEW: 'user.view',
  USER_STATUS_MANAGE: 'user.status.manage',
  CUSTOMER_VIEW: 'customer.view',
  CUSTOMER_MANAGE: 'customer.manage',
  WORKER_VIEW: 'worker.view',
  WORKER_MANAGE: 'worker.manage',
  CATEGORY_MANAGE: 'category.manage',
  AREA_MANAGE: 'area.manage',
  VERIFICATION_REVIEW: 'verification.review',
  VERIFICATION_DECIDE: 'verification.decide',
  VERIFICATION_DOCUMENT_VIEW: 'verification.document.view',
  VERIFICATION_CONFIGURE: 'verification.configure',
  MATCHING_RUN: 'matching.run',
  BOOKING_VIEW: 'booking.view',
  BOOKING_MANAGE: 'booking.manage',
  PAYMENT_VIEW: 'payment.view',
  PAYMENT_REFUND: 'payment.refund',
  PAYMENT_MANAGE: 'payment.manage',
  NOTIFICATION_MANAGE: 'notification.manage',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_MANAGE: 'attendance.manage',
  REPLACEMENT_VIEW: 'replacement.view',
  REPLACEMENT_MANAGE: 'replacement.manage',
  RATING_VIEW: 'rating.view',
  RATING_MODERATE: 'rating.moderate',
  SUPPORT_VIEW: 'support.view',
  SUPPORT_MANAGE: 'support.manage',
  SUPPORT_CATEGORY_MANAGE: 'support.category.manage',
  REPORT_VIEW: 'report.view',
  ROLE_MANAGE: 'role.manage',
  AUDIT_VIEW: 'audit.view',
} as const;

export const PERMISSION_CATALOG: ReadonlyArray<{
  code: (typeof PermissionCode)[keyof typeof PermissionCode];
  description: string;
}> = [
  {
    code: PermissionCode.ADMIN_MANAGE_USERS,
    description: 'Create admin accounts and change admin account status',
  },
  { code: PermissionCode.USER_VIEW, description: 'View a user account' },
  {
    code: PermissionCode.USER_STATUS_MANAGE,
    description: 'Suspend or reactivate customer and worker accounts',
  },
  {
    code: PermissionCode.CUSTOMER_VIEW,
    description: 'View customer profiles, addresses and notes',
  },
  {
    code: PermissionCode.CUSTOMER_MANAGE,
    description: 'Change customer verification status and add notes',
  },
  { code: PermissionCode.WORKER_VIEW, description: 'View worker profiles and availability' },
  {
    code: PermissionCode.WORKER_MANAGE,
    description: 'Edit worker profiles and availability on a worker behalf (assisted onboarding)',
  },
  { code: PermissionCode.CATEGORY_MANAGE, description: 'View and manage service categories' },
  { code: PermissionCode.AREA_MANAGE, description: 'View and manage service areas' },
  {
    code: PermissionCode.VERIFICATION_REVIEW,
    description: 'View the verification queue and worker verification status, start a review',
  },
  {
    code: PermissionCode.VERIFICATION_DECIDE,
    description: 'Approve or reject a verification check, trigger a re-check',
  },
  {
    code: PermissionCode.VERIFICATION_DOCUMENT_VIEW,
    description: 'Open KYC documents (a short-lived link is issued and audited)',
  },
  {
    code: PermissionCode.VERIFICATION_CONFIGURE,
    description: 'Choose which checks are required for a worker to count as verified',
  },
  {
    code: PermissionCode.MATCHING_RUN,
    description: 'Run manual worker matching for a requirement',
  },
  { code: PermissionCode.BOOKING_VIEW, description: 'View bookings and their timeline' },
  {
    code: PermissionCode.BOOKING_MANAGE,
    description:
      'Match, schedule, confirm, cancel and otherwise move bookings on behalf of the parties',
  },
  {
    code: PermissionCode.PAYMENT_VIEW,
    description: 'View payments, receipts and fee configuration',
  },
  { code: PermissionCode.PAYMENT_REFUND, description: 'Initiate a refund' },
  {
    code: PermissionCode.PAYMENT_MANAGE,
    description: 'Configure fees and reconcile a payment with the gateway',
  },
  {
    code: PermissionCode.NOTIFICATION_MANAGE,
    description: 'Manage notification templates and view the delivery log',
  },
  { code: PermissionCode.ATTENDANCE_VIEW, description: 'View attendance records' },
  {
    code: PermissionCode.ATTENDANCE_MANAGE,
    description: 'Record and correct attendance on behalf of the parties (audited)',
  },
  { code: PermissionCode.REPLACEMENT_VIEW, description: 'View replacement requests' },
  {
    code: PermissionCode.REPLACEMENT_MANAGE,
    description: 'Approve or reject replacement requests and select the replacement worker',
  },
  { code: PermissionCode.RATING_VIEW, description: 'View all ratings and reviews' },
  {
    code: PermissionCode.RATING_MODERATE,
    description: 'Hide or restore a rating or review (abusive content, audited)',
  },
  { code: PermissionCode.SUPPORT_VIEW, description: 'View support tickets and their history' },
  {
    code: PermissionCode.SUPPORT_MANAGE,
    description: 'Assign, prioritise, escalate and close support tickets',
  },
  {
    code: PermissionCode.SUPPORT_CATEGORY_MANAGE,
    description: 'Manage the configured list of support categories',
  },
  { code: PermissionCode.REPORT_VIEW, description: 'View the read-only operational reports' },
  {
    code: PermissionCode.ROLE_MANAGE,
    description: 'View roles and permissions and change which permissions a role holds',
  },
  { code: PermissionCode.AUDIT_VIEW, description: 'Read the audit log' },
];

/**
 * Permissions that only the SUPER_ADMIN role may ever hold (FRD section 2: "Role management and audit logs - Super Admin
 * only"; admin account creation is Super Admin, FM-01). The role-permission API refuses to map them to any other role, so a
 * delegated role administrator cannot promote a role into administration of administration.
 */
export const SUPER_ADMIN_ONLY_PERMISSION_CODES: readonly string[] = [
  PermissionCode.ROLE_MANAGE,
  PermissionCode.AUDIT_VIEW,
  PermissionCode.ADMIN_MANAGE_USERS,
];

/** Permissions given to SUPER_ADMIN by the seed (FRD §2: Super Admin has full access to every capability). */
export const SUPER_ADMIN_PERMISSION_CODES = PERMISSION_CATALOG.map((p) => p.code);
