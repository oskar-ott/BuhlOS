import { z } from "zod";

/**
 * Zod schemas for the production login store (`users.json`), consumed through
 * the legacy `/api/users` endpoint. This is the SOURCE OF TRUTH for Phil job
 * visibility: a field worker sees a job in /phil/jobs only when their
 * `users.json` record's `assignedJobIds` includes the job id (api/jobs.js GET
 * filters non-admin lists to assignedJobIds). It is deliberately distinct from
 * the onboarding `employees` domain (employees.json), which never mutates
 * users.json — see src/domains/employees/schema.ts.
 *
 * SECURITY: api/users.js strips `passwordHash` from every response. These
 * schemas use strict objects (no `.passthrough()`), so even if a future API
 * change leaked a hash, the parsed client object would drop it — the panel and
 * its callers only ever hold the four assignment-relevant fields.
 */

/** One user account as returned by `/api/users` (passwordHash already stripped). */
export const UserAccountSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: z.string(),
  /** The assignment array Phil visibility reads. Absent on legacy rows → []. */
  assignedJobIds: z.array(z.string()).optional(),
  /** Lifecycle flags — a disabled/archived account is not assignable. */
  archived: z.boolean().optional(),
  disabled: z.boolean().optional(),
  status: z.string().optional(),
});

export const UsersListResponseSchema = z.object({
  users: z.array(UserAccountSchema),
});

/** `PUT /api/users` returns the single updated account (no hash). */
export const UserMutationResponseSchema = z.object({
  user: UserAccountSchema,
});
