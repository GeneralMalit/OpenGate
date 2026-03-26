import type { OpenGateConfig } from "./types.js";
export type ConfigSource = OpenGateConfig | string | undefined;
export type ConfigValidationIssue = {
    path: string;
    message: string;
};
export type ConfigValidationSuccess = {
    ok: true;
    config: OpenGateConfig;
    warnings: string[];
};
export type ConfigValidationFailure = {
    ok: false;
    issues: ConfigValidationIssue[];
};
export type ConfigValidationReport = ConfigValidationSuccess | ConfigValidationFailure;
export declare class ConfigValidationError extends Error {
    readonly issues: ConfigValidationIssue[];
    constructor(issues: ConfigValidationIssue[]);
}
export declare function validateConfig(raw: unknown, baseDir?: string): OpenGateConfig;
export declare function loadConfig(source?: ConfigSource): OpenGateConfig;
export declare function validateConfigDetailed(raw: unknown, baseDir?: string): ConfigValidationReport;
export declare function migrateConfig(raw: unknown, baseDir?: string): ConfigValidationSuccess;
