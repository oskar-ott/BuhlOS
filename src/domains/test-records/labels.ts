import type { ReportType, TestType } from "./schema";

/**
 * Display labels for structured test records (#517/#519) — ONE source of truth
 * shared by the admin review panel and the printable compliance pack, so a
 * test type never reads differently on screen vs on the handover document.
 *
 * Unknown values (the schema's `other` long tail arrives verbatim) fall back to
 * the stored string — reproduced as recorded, never guessed.
 */

export const TEST_TYPE_LABEL: Record<TestType, string> = {
  continuity_r1r2: "Continuity (R1+R2)",
  continuity_r2: "Continuity (R2)",
  ring_continuity: "Ring continuity",
  insulation_resistance: "Insulation resistance",
  polarity: "Polarity",
  earth_fault_loop_zs: "Earth loop (Zs)",
  earth_electrode_resistance: "Earth electrode",
  prospective_fault_current: "Fault current (PFC)",
  rcd_trip_time: "RCD trip time",
  rcd_trip_current: "RCD trip current",
  functional: "Functional check",
  other: "Other",
};

export function testTypeLabel(type: string): string {
  return (TEST_TYPE_LABEL as Record<string, string>)[type] ?? type;
}

export const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  eicr: "EICR",
  eic: "EIC",
  minor_works: "Minor works",
  other: "Test record",
};

export function reportTypeLabel(type: string): string {
  return (REPORT_TYPE_LABEL as Record<string, string>)[type] ?? type;
}
