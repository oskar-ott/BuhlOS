import { describe, expect, it } from "vitest";
import type { HttpResult } from "@/lib/http";
import {
  entryMatchesAttempt,
  retryDay,
  sendDay,
  type SaveAttempt,
  type SaveWire,
} from "./hours-save";
import { buildStandardDayPayload } from "./service";
import { buildResubmitPayload } from "./resubmit";
import type { TimeEntry, TimeEntryListResponse, TimeEntryMutationResponse } from "./types";

const DATE = "2026-10-15";

function stored(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "e1",
    userId: "u1",
    date: DATE,
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "submitted",
    allocations: [{ jobId: "bondi", hours: 7.6 }],
    createdAt: "2026-10-15T07:00:00Z",
    updatedAt: "2026-10-15T07:00:00Z",
    notes: null,
    ...over,
  } as TimeEntry;
}

const TIMEOUT: HttpResult<never> = {
  ok: false,
  error: { status: 0, kind: "timeout", body: null, message: "timed out" },
};

/** A fake wire that records every call and answers from a script. */
function fakeWire(script: {
  create?: Array<HttpResult<TimeEntryMutationResponse>>;
  patch?: Array<HttpResult<TimeEntryMutationResponse>>;
  readDay?: Array<HttpResult<TimeEntryListResponse>>;
}) {
  const calls = { create: [] as string[], patch: [] as string[], readDay: 0 };
  const wire: SaveWire = {
    async create(_payload, key) {
      calls.create.push(key);
      return script.create?.shift() ?? TIMEOUT;
    },
    async patch(_date, _payload, key) {
      calls.patch.push(key);
      return script.patch?.shift() ?? TIMEOUT;
    },
    async readDay() {
      calls.readDay += 1;
      return script.readDay?.shift() ?? TIMEOUT;
    },
  };
  return { wire, calls };
}

const createAttempt: SaveAttempt = {
  mode: "create",
  date: DATE,
  payload: buildStandardDayPayload({ date: DATE, jobId: "bondi" }),
  key: "key-1",
  action: "log",
};

describe("sendDay", () => {
  it("a confirmed save returns the server's entry", async () => {
    const { wire } = fakeWire({ create: [{ ok: true, data: { entry: stored() } }] });
    const out = await sendDay(wire, createAttempt);
    expect(out.kind).toBe("saved");
  });

  it("a refusal is 'refused' with the plain-words problem; a timeout is 'unconfirmed'", async () => {
    const refused = fakeWire({
      create: [
        {
          ok: false,
          error: {
            status: 400,
            body: { error: "totalHours must be ≤ 16" },
            message: "Bad Request",
          },
        },
      ],
    });
    const r = await sendDay(refused.wire, createAttempt);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.problem.title).toBe("Those hours don't add up");

    const timedOut = fakeWire({ create: [TIMEOUT] });
    const t = await sendDay(timedOut.wire, createAttempt);
    expect(t.kind).toBe("unconfirmed");
    if (t.kind === "unconfirmed")
      expect(t.problem.title).toBe("No answer — it may not have gone through");
  });
});

describe("retryDay never sends twice", () => {
  it("re-reads first: when the day is already there, nothing is resent", async () => {
    const { wire, calls } = fakeWire({ readDay: [{ ok: true, data: { entries: [stored()] } }] });
    const out = await retryDay(wire, createAttempt);
    expect(out.kind).toBe("saved");
    expect(calls.readDay).toBe(1);
    expect(calls.create).toEqual([]);
  });

  it("when the day isn't there, it resends ONCE with the SAME key", async () => {
    const { wire, calls } = fakeWire({
      readDay: [{ ok: true, data: { entries: [] } }],
      create: [{ ok: true, data: { entry: stored() } }],
    });
    const out = await retryDay(wire, createAttempt);
    expect(out.kind).toBe("saved");
    expect(calls.create).toEqual(["key-1"]);
  });

  it("a timed-out first send, then try again with the day present: one wire write in total", async () => {
    const { wire, calls } = fakeWire({
      create: [TIMEOUT],
      readDay: [{ ok: true, data: { entries: [stored()] } }],
    });
    const first = await sendDay(wire, createAttempt);
    expect(first.kind).toBe("unconfirmed");
    const second = await retryDay(wire, createAttempt);
    expect(second.kind).toBe("saved");
    expect(calls.create).toHaveLength(1);
  });

  it("when the re-read itself gets no answer, nothing is resent and the day stays unconfirmed", async () => {
    const { wire, calls } = fakeWire({ readDay: [TIMEOUT] });
    const out = await retryDay(wire, createAttempt);
    expect(out.kind).toBe("unconfirmed");
    expect(calls.create).toEqual([]);
  });

  it("a change (patch): the OLD copy being there is not a match, so the change is resent", async () => {
    const patch: SaveAttempt = {
      mode: "patch",
      date: DATE,
      payload: buildResubmitPayload(
        { date: DATE },
        { totalHours: 8.6, jobId: "bondi", notes: null }
      ),
      key: "key-2",
      action: "change",
    };
    expect(entryMatchesAttempt(stored(), patch)).toBe(false);
    expect(
      entryMatchesAttempt(
        stored({
          totalHours: 8.6,
          ordinaryHours: 7.6,
          overtimeHours: 1,
          allocations: [{ jobId: "bondi", hours: 8.6 }],
        }),
        patch
      )
    ).toBe(true);
    const { wire, calls } = fakeWire({
      readDay: [{ ok: true, data: { entries: [stored()] } }],
      patch: [{ ok: true, data: { entry: stored({ totalHours: 8.6 }) } }],
    });
    const out = await retryDay(wire, patch);
    expect(out.kind).toBe("saved");
    expect(calls.patch).toEqual(["key-2"]);
  });
});
