import { z } from "zod";

/** Per-job contacts wire shape (api/contacts.js, #189). Legacy email-list
 *  rows carry no `category` — the Phil card filters them out. */
export const JobContactSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    role: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    category: z.string().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough();

export const JobContactsResponseSchema = z.object({
  contacts: z.array(JobContactSchema),
});

export type JobContact = z.infer<typeof JobContactSchema>;
