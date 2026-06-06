import { z } from "zod";

/**
 * Zod schemas matching api/_lib/time-entries.js wire shape verbatim.
 *
 * Anything the legacy server emits is parsed through these schemas; anything
 * the new client sends to /api/time-entries* is validated against these.
 *
 * Validation rules mirror api/_lib/time-entries.js `validateEntryShape()`:
 *  - date matches YYYY-MM-DD
 *  - totalHours > 0, ≤ 16 (audit doc §validation; legacy server has no upper bound
 *    but lifts the brief's ≤ 16 to prevent obvious typos like 80h)
 *  - ordinaryHours + overtimeHours === totalHours (±0.01)
 *  - allocations.length ≥ 1, each hours > 0, sum equals totalHours (±0.01)
 *  - status in {draft, submitted, approved, rejected}
 *  - notes ≤ 500 chars
 *
 * Field names match the legacy server (`rejectedReason`, not `rejectionReason`).
 *
 * Cross-ref: docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §validation
 */

export const TIME_ENTRY_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;

export const TimeEntryStatusSchema = z.enum(TIME_ENTRY_STATUSES);

const HOURS_TOLERANCE = 0.01;

export const TimeEntryAllocationSchema = z
  .object({
    jobId: z.string().nullable(),
    hours: z.number().positive(),
    notes: z.string().nullable().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
    // Approver-enriched fields returned by GET ?scope=approver.
    jobName: z.string().nullable().optional(),
    _jobLedByMe: z.boolean().optional(),
  })
  .passthrough();

/**
 * Full time-entry row as stored / returned by the server.
 *
 * Many fields are nullable rather than optional because the server explicitly
 * writes `null` when the value is absent (e.g. an entry with no rejection
 * reason has `rejectedReason: null`, not missing).
 */
export const TimeEntrySchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    userName: z.string().nullable().optional(),
    userRole: z.string().nullable().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
    breakMinutes: z.number().nullable().optional(),
    totalHours: z.number(),
    ordinaryHours: z.number(),
    overtimeHours: z.number(),
    otOverridden: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    status: TimeEntryStatusSchema,
    submittedAt: z.string().nullable().optional(),
    approvedBy: z.string().nullable().optional(),
    approvedAt: z.string().nullable().optional(),
    rejectedReason: z.string().nullable().optional(),
    rejectedAt: z.string().nullable().optional(),
    rejectedBy: z.string().nullable().optional(),
    allocations: z.array(TimeEntryAllocationSchema).min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    enteredByUserId: z.string().nullable().optional(),
    enteredByName: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    updatedBy: z.string().nullable().optional(),
    updatedByName: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Payload the client POSTs to /api/time-entries to create a draft or submit.
 *
 * Server fills id/userId/userName/userRole/timestamps from the session cookie;
 * the client only sends the shape below.
 */
export const CreateTimeEntryPayloadSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
    totalHours: z
      .number()
      .positive("Total hours must be greater than zero")
      .max(16, "Total hours cannot exceed 16"),
    ordinaryHours: z.number().min(0, "Ordinary hours cannot be negative"),
    overtimeHours: z.number().min(0, "Overtime hours cannot be negative"),
    allocations: z
      .array(
        z.object({
          jobId: z.string().nullable(),
          hours: z.number().positive("Allocation hours must be greater than zero"),
          notes: z.string().max(500, "Notes too long").nullable().optional(),
        })
      )
      .min(1, "At least one job allocation is required"),
    notes: z.string().max(500, "Notes too long").nullable().optional(),
    startTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
    breakMinutes: z.number().nullable().optional(),
    otOverridden: z.boolean().optional(),
    status: z.enum(["draft", "submitted"]).optional(),
  })
  .superRefine((data, ctx) => {
    if (Math.abs(data.ordinaryHours + data.overtimeHours - data.totalHours) > HOURS_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ordinary + overtime hours must equal total hours",
        path: ["totalHours"],
      });
    }
    const sum = data.allocations.reduce((s, a) => s + a.hours, 0);
    if (Math.abs(sum - data.totalHours) > HOURS_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allocation hours must sum to total hours",
        path: ["allocations"],
      });
    }
  });

/**
 * Payload the client PATCHes to /api/time-entries?date=YYYY-MM-DD when
 * editing a draft / rejected entry (rejected workers re-edit and resubmit).
 */
export const PatchTimeEntryPayloadSchema = CreateTimeEntryPayloadSchema;

export const ApproveTimeEntryPayloadSchema = z.object({
  userId: z.string().min(1, "userId required"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
});

export const RejectTimeEntryPayloadSchema = z.object({
  userId: z.string().min(1, "userId required"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  reason: z.string().min(1, "Rejection reason is required").max(500, "Rejection reason too long"),
});

export const TimeEntryListResponseSchema = z.object({
  entries: z.array(TimeEntrySchema),
});

export const TimeEntryMutationResponseSchema = z.object({
  entry: TimeEntrySchema,
});

/**
 * Schemas for GET /api/time-entries-overview (admin/LH cross-user rollup).
 *
 * The wire shape mirrors api/time-entries-overview.js verbatim. Totals are
 * computed server-side by summing *allocation* hours so per-job figures stay
 * correct when an entry is split across jobs. `missing` is the existing
 * server-side missing-hours detection (assigned crew, weekdays, past/today).
 *
 * `entries` are enriched (userName + per-allocation jobName) but still satisfy
 * TimeEntrySchema, which is already permissive (`.passthrough()`), so we reuse
 * it rather than declaring a second entry shape that could drift.
 */
export const OverviewByJobSchema = z.object({
  jobId: z.string().nullable(),
  jobName: z.string(),
  hours: z.number(),
});

export const OverviewByUserSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  role: z.string().nullable(),
  hours: z.number(),
});

export const OverviewByDateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.number(),
  count: z.number().int().nonnegative(),
});

export const OverviewByStatusSchema = z.object({
  draft: z.number().int().nonnegative(),
  submitted: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});

export const OverviewTotalsSchema = z.object({
  totalHours: z.number(),
  byJob: z.array(OverviewByJobSchema),
  byUser: z.array(OverviewByUserSchema),
  byDate: z.array(OverviewByDateSchema),
  byStatus: OverviewByStatusSchema,
});

/**
 * One missing-hours alert: an assigned crew member with no entry of any
 * status on a given weekday. Field names match the server (`userName`, not
 * `workerName`).
 */
export const MissingLogSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userId: z.string(),
  userName: z.string(),
  role: z.string().nullable().optional(),
});

export const OverviewJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

export const OverviewUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: z.string().nullable().optional(),
});

export const TimeEntryOverviewResponseSchema = z.object({
  range: z.object({
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  entries: z.array(TimeEntrySchema),
  totals: OverviewTotalsSchema,
  missing: z.array(MissingLogSchema),
  jobs: z.array(OverviewJobSchema),
  users: z.array(OverviewUserSchema),
});

/**
 * Schemas for GET /api/time-entries-export?dryRun=1&format=json (admin-only
 * payroll preview). The dry-run never stamps entries, so it's safe to call on
 * page load to show "what would export this week" before the admin commits to
 * the real CSV download.
 *
 * We model only `range` + `summary` (the numbers the preview card shows) and
 * ignore the `rows[]` payload — the page never renders individual rows, the
 * CSV download is the artifact for that. The wire shape mirrors
 * api/time-entries-export.js `summarise()`.
 */
export const PayrollExportSummarySchema = z
  .object({
    rowCount: z.number().int().nonnegative(),
    totalHours: z.number(),
    totalCostExGst: z.number(),
    workerCount: z.number().int().nonnegative(),
    jobCount: z.number().int().nonnegative(),
  })
  .passthrough();

export const PayrollExportPreviewResponseSchema = z
  .object({
    range: z
      .object({
        fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        status: z.string(),
        dryRun: z.boolean(),
      })
      .passthrough(),
    summary: PayrollExportSummarySchema,
  })
  .passthrough();

/**
 * Schemas for GET /api/today-pulse?date=YYYY-MM-DD — the live "what's on site
 * today" snapshot that backs the end-of-day closeout panel on /hours. Same
 * numbers the 17:00 digest cron composes, but on-demand at any point in the
 * day. Staff-gated (admin = all; leading-hand = own jobs; 403 otherwise).
 *
 * We model the whole response (hours + snags + jobs) so the typed client is
 * honest about what the endpoint returns, but the closeout panel only renders
 * the `hours` block. `.passthrough()` keeps future fields from breaking parse.
 *
 * Wire shape mirrors api/today-pulse.js verbatim.
 */
export const TodayPulseHoursSchema = z
  .object({
    submittedCount: z.number().int().nonnegative(),
    submittedTotal: z.number(),
    approvedCount: z.number().int().nonnegative(),
    approvedTotal: z.number(),
    pendingCount: z.number().int().nonnegative(),
    draftCount: z.number().int().nonnegative(),
    crewOnSite: z.number().int().nonnegative(),
  })
  .passthrough();

export const TodayPulseSnagsSchema = z
  .object({
    openedToday: z.number().int().nonnegative(),
    resolvedToday: z.number().int().nonnegative(),
  })
  .passthrough();

export const TodayPulseJobsSchema = z
  .object({
    activeJobs: z.number().int().nonnegative(),
    jobsWithActivityToday: z.number().int().nonnegative(),
  })
  .passthrough();

export const TodayPulseResponseSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hours: TodayPulseHoursSchema,
    snags: TodayPulseSnagsSchema,
    jobs: TodayPulseJobsSchema,
  })
  .passthrough();

export const ApiErrorBodySchema = z.object({
  error: z.string(),
});
