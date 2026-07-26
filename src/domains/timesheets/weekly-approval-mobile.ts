/**
 * Shim — the pure weekly-review view-model behind WeeklyHoursApprovalMobile
 * moved to ./weekly-review when the DESKTOP closeout wizard started sharing it
 * (lean-reset redesign): the band partition, ordinary/overtime split, query
 * reasons and stepper queue are surface-agnostic projections, not phone code.
 * This re-export keeps the mobile surface and its tests importing unchanged.
 */
export * from "./weekly-review";
