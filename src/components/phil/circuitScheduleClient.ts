import { philWrite, type PhilWriteResult } from "@/domains/phil/write-client";
import {
  CircuitBoardsResponseSchema,
  type Board,
  type InstallState,
} from "@/domains/circuit-schedule/schema";

/**
 * Phil-side writes for the circuit schedule. Routed through `philWrite` so every
 * field write gets a bounded timeout, an offline pre-check, and one honest
 * message per failure mode (P7/P8) — never an infinite spinner.
 *
 *   setInstallField  — POST ?action=set-install: mark ONE way to-do→installed→
 *                      tested. Tiny body, the common on-site action (P6).
 *   saveBoardsField  — PUT { boards }: structural edits (add/edit/delete board
 *                      or way) replace the schedule wholesale, the same contract
 *                      the office builder uses.
 *
 * The server gates both to an assigned, non-client worker (the field owns the
 * schedule); a 403 surfaces as an honest http error the caller shows.
 */

export interface SetInstallResult {
  boardId: string;
  circuitId: string;
  install: InstallState;
}

export function setInstallField(
  jobId: string,
  boardId: string,
  circuitId: string,
  install: InstallState,
): Promise<PhilWriteResult<SetInstallResult>> {
  return philWrite<SetInstallResult>(
    `/api/job-circuits?jobId=${encodeURIComponent(jobId)}&action=set-install`,
    { boardId, circuitId, install },
    (raw) => {
      if (raw && typeof raw === "object") {
        const r = raw as { boardId?: unknown; circuitId?: unknown; install?: unknown };
        if (r.install === "todo" || r.install === "installed" || r.install === "tested") {
          return {
            boardId: typeof r.boardId === "string" ? r.boardId : boardId,
            circuitId: typeof r.circuitId === "string" ? r.circuitId : circuitId,
            install: r.install,
          };
        }
      }
      return null;
    },
  );
}

export function saveBoardsField(
  jobId: string,
  boards: Board[],
): Promise<PhilWriteResult<Board[]>> {
  return philWrite<Board[]>(
    `/api/job-circuits?jobId=${encodeURIComponent(jobId)}`,
    { boards },
    (raw) => {
      const parsed = CircuitBoardsResponseSchema.safeParse(raw);
      return parsed.success ? parsed.data.boards : null;
    },
    { method: "PUT" },
  );
}
