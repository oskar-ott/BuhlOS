import type { z } from "zod";
import type {
  CircuitSchema,
  CircuitScheduleResponseSchema,
  SwitchboardSchema,
  CIRCUIT_DEVICES,
  CIRCUIT_STATUSES,
  CIRCUIT_TYPES,
} from "./schema";

export type Switchboard = z.infer<typeof SwitchboardSchema>;
export type Circuit = z.infer<typeof CircuitSchema>;
export type CircuitScheduleResponse = z.infer<typeof CircuitScheduleResponseSchema>;

export type CircuitDevice = (typeof CIRCUIT_DEVICES)[number];
export type CircuitType = (typeof CIRCUIT_TYPES)[number];
export type CircuitStatus = (typeof CIRCUIT_STATUSES)[number];

/** The write payload the builder sends to PUT /api/job-circuits. */
export interface CircuitSchedulePayload {
  switchboards: Switchboard[];
  circuits: Circuit[];
}
