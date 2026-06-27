import type { SafetyDoc, SafetyAck, SafetyDocRollup } from "./schema";

/**
 * Pure projections over safety docs + acknowledgements (#219). No IO — the
 * handler (api/safety-docs.js) reads the two blobs and the assigned-worker list,
 * then calls these. Kept pure so the acknowledgement logic is unit-tested
 * without a server.
 */

export type AssignedWorker = { id: string; name: string };

/** Only the non-superseded ("current") docs — what the field ever sees. */
export function currentDocs(docs: SafetyDoc[]): SafetyDoc[] {
  return docs.filter((d) => d.status === "current");
}

export function hasAcknowledged(acks: SafetyAck[], docId: string, userId: string): boolean {
  return acks.some((a) => a.docId === docId && a.userId === userId);
}

/** Of the current docs, the ids the given user has acknowledged. */
export function acknowledgedDocIds(
  currents: SafetyDoc[],
  acks: SafetyAck[],
  userId: string
): string[] {
  const live = new Set(currents.map((d) => d.id));
  return acks.filter((a) => a.userId === userId && live.has(a.docId)).map((a) => a.docId);
}

/**
 * Per current doc: which assigned workers have acknowledged THIS version and
 * which are outstanding. Acks key off the version-specific doc id, so a
 * superseded version's acks never count for the new one.
 */
export function computeAckRollup(
  currents: SafetyDoc[],
  acks: SafetyAck[],
  workers: AssignedWorker[]
): SafetyDocRollup[] {
  return currents.map((doc) => {
    const acknowledged: Array<{ userId: string; name: string; at: string }> = [];
    const outstanding: Array<{ userId: string; name: string }> = [];
    for (const w of workers) {
      const ack = acks.find((a) => a.docId === doc.id && a.userId === w.id);
      if (ack) acknowledged.push({ userId: w.id, name: w.name, at: ack.at });
      else outstanding.push({ userId: w.id, name: w.name });
    }
    return { doc, acknowledged, outstanding };
  });
}

/**
 * Readiness seam (#371): has a worker acknowledged EVERY current safety doc?
 * True when there is nothing to acknowledge (the caller decides whether an empty
 * register means "not tracked"). Lets api/job-readiness.js light up its
 * `safetyDocs` signal later without a second engine.
 */
export function allAcknowledgedByWorker(
  currents: SafetyDoc[],
  acks: SafetyAck[],
  workerId: string
): boolean {
  if (currents.length === 0) return true;
  return currents.every((d) => hasAcknowledged(acks, d.id, workerId));
}

/** The version number a new upload should take when it supersedes `prior`. */
export function nextVersion(prior: SafetyDoc | null | undefined): number {
  return prior && Number.isFinite(prior.version) ? prior.version + 1 : 1;
}
