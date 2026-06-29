// Type declarations for the CommonJS feature-settings registry
// (api/_lib/feature-settings.js) so src/ server code and tests consume it
// type-checked. Add new settings to SETTINGS_REGISTRY in the JS; this mirror
// keeps the helper signatures honest.

export type SettingType = "number" | "string" | "boolean" | "enum";
export type SettingValue = number | string | boolean;

export interface SettingDef {
  type: SettingType;
  label: string;
  description: string;
  default: SettingValue;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  options?: string[];
  unit?: string;
}

export type SettingItem = SettingDef & { featureKey: string; key: string };

export declare const SETTINGS_REGISTRY: Record<string, Record<string, SettingDef>>;
export declare const SETTINGS_KEY: string;
export declare function definitionOf(featureKey: string, key: string): SettingDef;
export declare function isValid(def: SettingDef, value: unknown): boolean;
export declare function coerce(def: SettingDef, raw: unknown): SettingValue;
export declare function getSetting(featureKey: string, key: string): Promise<SettingValue>;
export declare function getSettings(featureKey: string): Promise<Record<string, SettingValue>>;
export declare function validateWrite(
  featureKey: string,
  key: string,
  value: unknown,
): { ok: true; value: SettingValue } | { ok: false; error: string };
export declare function listSettings(): SettingItem[];
