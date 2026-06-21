// Type surface for the J11 process-local admin task-read diagnostics
// (admin-task-read-diagnostics.js). Same shape as the J10 Phil module — reuse its
// types so the two stay in lock-step.

import type { TaskReadLastDiag, TaskReadDiagnosticsSnapshot } from "./task-read-diagnostics";

export function recordAdminTaskRead(diag: Partial<TaskReadLastDiag>): void;
export function getAdminTaskReadDiagnostics(): TaskReadDiagnosticsSnapshot;
export function resetAdminTaskReadDiagnostics(): void;
