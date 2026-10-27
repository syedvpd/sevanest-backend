import type { AppConfigService } from '../../config/app-config.service';

/**
 * The app start-up values an administrator can change without a deployment (GET /app-config). A database row overrides the
 * environment value of the same key; with no row the environment value (or "not set") applies. Nothing here is a business rule:
 * every value is content the business supplies.
 */
export type SettingKind = 'string' | 'boolean';

export interface SettingDefinition {
  key: string;
  kind: SettingKind;
  maxLength: number;
  /** Format rule for string values; the message is returned to the administrator. */
  pattern?: { regex: RegExp; message: string };
  description: string;
  fromEnv: (config: AppConfigService) => string | boolean | undefined;
}

const VERSION = { regex: /^\d{1,4}\.\d{1,4}\.\d{1,4}$/, message: 'Use a version like 1.4.0' };
const HTTPS_URL = { regex: /^https:\/\/[^\s]+$/, message: 'Use a full https:// link' };
const PHONE = { regex: /^\+?[0-9][0-9 ()-]{5,24}$/, message: 'Use digits, optionally with +' };
const EMAIL = { regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Use a valid e-mail address' };

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'customerMinVersion',
    kind: 'string',
    maxLength: 20,
    pattern: VERSION,
    description: 'Oldest customer app version that may keep running; older apps are told to update',
    fromEnv: (c) => c.appPolicy.minVersionCustomer,
  },
  {
    key: 'customerStoreUrl',
    kind: 'string',
    maxLength: 500,
    pattern: HTTPS_URL,
    description: 'Store link for the customer app update screen',
    fromEnv: (c) => c.appPolicy.storeUrlCustomer,
  },
  {
    key: 'workerMinVersion',
    kind: 'string',
    maxLength: 20,
    pattern: VERSION,
    description: 'Oldest worker app version that may keep running',
    fromEnv: (c) => c.appPolicy.minVersionWorker,
  },
  {
    key: 'workerStoreUrl',
    kind: 'string',
    maxLength: 500,
    pattern: HTTPS_URL,
    description: 'Store link for the worker app update screen',
    fromEnv: (c) => c.appPolicy.storeUrlWorker,
  },
  {
    key: 'maintenance',
    kind: 'boolean',
    maxLength: 5,
    description: 'true shows the maintenance screen in both apps',
    fromEnv: (c) => c.appPolicy.maintenance,
  },
  {
    key: 'supportPhone',
    kind: 'string',
    maxLength: 30,
    pattern: PHONE,
    description: 'Support phone number shown in the apps',
    fromEnv: (c) => c.appPolicy.supportPhone,
  },
  {
    key: 'supportEmail',
    kind: 'string',
    maxLength: 200,
    pattern: EMAIL,
    description: 'Support e-mail address shown in the apps',
    fromEnv: (c) => c.appPolicy.supportEmail,
  },
  {
    key: 'cancellationPolicyText',
    kind: 'string',
    maxLength: 4000,
    description: 'Approved cancellation policy text',
    fromEnv: (c) => c.policyContent.cancellationText,
  },
  {
    key: 'cancellationPolicyUrl',
    kind: 'string',
    maxLength: 500,
    pattern: HTTPS_URL,
    description: 'Link to the approved cancellation policy',
    fromEnv: (c) => c.policyContent.cancellationUrl,
  },
  {
    key: 'refundPolicyText',
    kind: 'string',
    maxLength: 4000,
    description: 'Approved refund policy text',
    fromEnv: (c) => c.policyContent.refundText,
  },
  {
    key: 'refundPolicyUrl',
    kind: 'string',
    maxLength: 500,
    pattern: HTTPS_URL,
    description: 'Link to the approved refund policy',
    fromEnv: (c) => c.policyContent.refundUrl,
  },
];

export const SETTING_KEYS = SETTING_DEFINITIONS.map((d) => d.key);
