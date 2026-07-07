"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PhilJobRoom } from "./philJobRooms";

/**
 * The in-job rooms ↔ tab-bar bridge (phil_job_rooms — the #133 experiment).
 *
 * When the four-rooms takeover is active on a job screen, the global Phil tab
 * bar's four flanking slots REBIND to the job's rooms (Now · Work · [Capture] ·
 * Proof · Site). The bar itself stays mounted in PhilTabBar — it owns the
 * Capture FAB, the camera input and the capture launcher, all of which must be
 * untouched — so the job screen registers a BINDING through this context and
 * the bar renders room tabs while one is present.
 *
 * Nothing registered (every screen today, and the job screen with the flag
 * off) ⇒ `binding` is null and the bar renders exactly as before — the default
 * context value keeps PhilTabBar byte-identical wherever no provider exists.
 *
 * The badges are the #133 criterion instrumentation ("critical state is never
 * hidden behind navigation"): real derived counts only, never invented.
 */
export interface PhilJobRoomsBarBinding {
  /** The room currently shown by the job screen. */
  active: PhilJobRoom;
  /** Live counts: Now = needs-you, Work = blocked tasks, Proof = proof owed. */
  badges: { now: number; work: number; proof: number };
  /** Select a room. Re-selecting the active room pops back to its root. */
  onSelect: (room: PhilJobRoom) => void;
}

interface PhilJobRoomsBarValue {
  binding: PhilJobRoomsBarBinding | null;
  setBinding: (binding: PhilJobRoomsBarBinding | null) => void;
}

/** Exported for render tests only — components use the hooks below. */
export const PhilJobRoomsBarContext = createContext<PhilJobRoomsBarValue>({
  binding: null,
  setBinding: () => {},
});

export function PhilJobRoomsBarProvider({ children }: { children: ReactNode }) {
  const [binding, setBinding] = useState<PhilJobRoomsBarBinding | null>(null);
  const value = useMemo(() => ({ binding, setBinding }), [binding]);
  return (
    <PhilJobRoomsBarContext.Provider value={value}>
      {children}
    </PhilJobRoomsBarContext.Provider>
  );
}

/** Read the current binding (PhilTabBar). Null = render the normal bar. */
export function usePhilJobRoomsBarBinding(): PhilJobRoomsBarBinding | null {
  return useContext(PhilJobRoomsBarContext).binding;
}

/** Register/clear the binding (the job screen). No provider ⇒ safe no-op. */
export function usePhilJobRoomsBarRegistration(): (
  binding: PhilJobRoomsBarBinding | null,
) => void {
  return useContext(PhilJobRoomsBarContext).setBinding;
}
