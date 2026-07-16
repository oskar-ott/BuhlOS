import type { z } from "zod";
import type {
  UserAccountSchema,
  UsersListResponseSchema,
  UserMutationResponseSchema,
} from "./schema";

export type UserAccount = z.infer<typeof UserAccountSchema>;
export type UsersListResponse = z.infer<typeof UsersListResponseSchema>;
export type UserMutationResponse = z.infer<typeof UserMutationResponseSchema>;

