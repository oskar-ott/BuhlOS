import type { z } from "zod";
import type {
  UserAccountSchema,
  UsersListResponseSchema,
  UserMutationResponseSchema,
} from "./schema";

export type UserAccount = z.infer<typeof UserAccountSchema>;
export type UsersListResponse = z.infer<typeof UsersListResponseSchema>;
export type UserMutationResponse = z.infer<typeof UserMutationResponseSchema>;

/**
 * The minimal, secret-free projection the assignment UI works with. Derived
 * from a UserAccount by toAssignableWorker() — it intentionally carries ONLY
 * the four fields the panel needs, so no other account data (email, rate, …)
 * ever reaches the worker-assignment surface.
 */
export interface AssignableWorker {
  id: string;
  username: string;
  role: string;
  assignedJobIds: ReadonlyArray<string>;
}

/** A single user's pending assignment change for this job (the PUT payload). */
export interface AssignmentChange {
  id: string;
  username: string;
  /** The user's FULL new assignedJobIds array — preserves their other jobs. */
  assignedJobIds: string[];
  /** true = being added to this job, false = being removed. */
  assigned: boolean;
}
