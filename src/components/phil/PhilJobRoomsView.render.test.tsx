import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// SSR stubs — same pattern as the other Phil render specs.
vi.mock("next/navigation", () => ({
  usePathname: () => "/phil/jobs/j1",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilJobRoomsView } from "./PhilJobRoomsView";
import type { AttentionItem } from "./PhilJobAttention";
import type { OwedProofItem } from "./philJobRooms";
import type { Job, JobAreaGroup } from "@/domains/jobs/types";
import type { WorkPackage } from "@/domains/job-control/types";
import type { TaskProgressRollup } from "@/domains/jobs/task-progress-rollup";

/**
 * SSR smoke for the four-rooms takeover (phil_job_rooms, dark — #133).
 * Pins each room's HONEST-ABSENCE branches (no fake "all clear", no invented
 * counts) and that real data renders real numbers.
 */

const groups = [
  {
    id: "g1",
    name: "Front of house",
    areas: [
      {
        id: "a1",
        name: "Reception",
        roughInTasks: [{ id: "t1", name: "Cable pulls" }],
        fitOffTasks: [],
      },
    ],
  },
] as unknown as ReadonlyArray<JobAreaGroup>;

const job = {
  id: "j1",
  name: "Level 12 Office Fitout",
  status: "active",
  code: "IV0041",
  siteAddress: "40 Kent St",
  areaGroups: groups,
} as unknown as Job;

const emptyRollup: TaskProgressRollup = {
  job: { total: 0, complete: 0, pct: null },
  byStage: {
    roughIn: { total: 0, complete: 0, pct: null },
    fitOff: { total: 0, complete: 0, pct: null },
  },
  byArea: {},
  bySystem: {},
};

type ViewProps = Parameters<typeof PhilJobRoomsView>[0];

function baseProps(over: Partial<ViewProps> = {}): ViewProps {
  return {
    job,
    room: "now",
    roomResetSeq: 0,
    onGoToRoom: () => {},
    areaOpen: false,
    onOpenArea: () => {},
    areaView: null,
    attention: { items: [], total: 0 },
    evidenceItems: [],
    captureBanner: null,
    areaNames: { a1: "Reception" },
    viewer: { id: "u1", role: "tradie" },
    onEvidenceUpdated: () => {},
    onOpenCapture: () => {},
    groups,
    workCounts: { total: 0, done: 0, going: 0, blocked: 0, todo: 0 },
    taskStatePending: false,
    taskStateErr: null,
    jobComplete: false,
    rollup: emptyRollup,
    blockedByArea: new Map(),
    owedByArea: new Map(),
    areaCountMaps: { snags: new Map(), itps: new Map(), photos: new Map() },
    workPackages: undefined,
    evidenceLinks: [],
    snags: [],
    snagContext: { stage: "roughIn", areaId: "a1" },
    owedProof: [],
    proofReviews: [],
    itps: [],
    tags: [],
    tagsError: false,
    hasCircuitSchedule: false,
    circuitBoards: undefined,
    certificatesEnabled: false,
    documents: [],
    documentsError: null,
    contacts: [],
    serviceLocations: [],
    serviceLocationsError: null,
    canWriteServiceLocations: false,
    onCapturePhotoForServices: () => Promise.resolve(null),
    siteInduction: null,
    safetyEnabled: false,
    ...over,
  };
}

function render(over: Partial<ViewProps> = {}) {
  return renderToString(createElement(PhilJobRoomsView, baseProps(over)));
}

describe("PhilJobRoomsView — chrome", () => {
  it("renders the ← Jobs exit + the job identity (code chip, name, sync pill)", () => {
    const html = render();
    expect(html).toContain("← Jobs");
    expect(html).toContain('href="/phil/jobs"');
    expect(html).toContain("IV0041");
    expect(html).toContain("Level 12 Office Fitout");
    // Truthful sync pill — SSR paints online ("Synced"), same as My Day.
    expect(html).toContain(">Synced<");
    expect(html).toContain("40 Kent St");
    // No fabricated job-switcher chevrons — identity only (deferred).
    expect(html).toContain('data-testid="phil-job-rooms-header"');
  });
});

describe("NOW room", () => {
  it("omits 'Needs you' entirely when nothing qualifies — never an empty all-clear", () => {
    const html = render({ room: "now" });
    expect(html).not.toContain("Needs you");
    // Capture + honest deferred note are always there.
    expect(html).toContain("Capture evidence");
    expect(html).toContain("Not connected in Phil yet");
  });

  it("renders real needs-you rows with the total in the heading", () => {
    const items: AttentionItem[] = [
      {
        id: "rejected:s1",
        tone: "danger",
        kind: "Snag rejected",
        title: "GPO height wrong",
        reasonShown: "Admin pushed back with a reason.",
        actionLabel: "Open Snags",
        anchor: "#phil-job-snags",
      },
    ];
    const html = render({ room: "now", attention: { items, total: 1 } });
    expect(html).toContain("Needs you · 1");
    expect(html).toContain("GPO height wrong");
    expect(html).toContain('data-testid="phil-room-needs-you-rejected:s1"');
  });
});

describe("WORK room", () => {
  it("shows real rolled-up counts + chips, and the area card's real n/m", () => {
    const html = render({
      room: "work",
      workCounts: { total: 84, done: 31, going: 8, blocked: 5, todo: 40 },
      rollup: {
        ...emptyRollup,
        byArea: { a1: { total: 9, complete: 4, pct: 44 } },
      },
      blockedByArea: new Map([["a1", 1]]),
      owedByArea: new Map([["a1", 2]]),
    });
    expect(html).toContain("31 of 84 tasks done");
    expect(html).toContain("5 blocked");
    expect(html).toContain("8 going");
    expect(html).toContain("40 to do");
    expect(html).toContain("Areas — Front of house");
    expect(html).toContain("Reception");
    expect(html).toContain("4/9");
    expect(html).toContain("1 blocked");
    expect(html).toContain("Proof needed");
    expect(html).toContain('data-testid="phil-room-area-card-a1"');
  });

  it("streams honestly: a skeleton while task state is pending, never a false zero", () => {
    const html = render({ room: "work", taskStatePending: true });
    expect(html).toContain('aria-label="Loading job progress"');
    expect(html).not.toContain("0 of 0 tasks done");
    expect(html).not.toContain("4/9");
  });

  it("omits the Scope row when no work packages are compiled (honest absence)", () => {
    const html = render({ room: "work" });
    expect(html).not.toContain("Scope of work");
  });

  it("shows the Scope row only for a REAL compiled artifact", () => {
    const html = render({
      room: "work",
      workPackages: [
        {
          id: "wp1",
          jobId: "j1",
          title: "Reception power",
          scopeClauseIds: [],
          boqLineRefs: [],
          taskRefs: [],
          order: 0,
        } as unknown as WorkPackage,
      ],
    });
    expect(html).toContain('data-testid="phil-room-scope-row"');
    expect(html).toContain("Scope of work");
    expect(html).toContain("1 package");
  });

  it("Issues row carries the real open count — 'Nothing open' when none", () => {
    const html = render({ room: "work" });
    expect(html).toContain('data-testid="phil-room-issues-row"');
    expect(html).toContain("Nothing open");
  });

  it("renders the parent-composed area view when the drill-in is open", () => {
    const html = render({
      room: "work",
      areaOpen: true,
      areaView: createElement("div", { "data-testid": "stub-area-view" }, "AREA"),
    });
    expect(html).toContain('data-testid="stub-area-view"');
    expect(html).not.toContain("phil-room-area-card-a1");
  });
});

describe("PROOF room", () => {
  it("names the reason when the office hasn't compiled proof requirements", () => {
    const html = render({ room: "proof" });
    expect(html).toContain("compiled proof requirements for this job yet");
    expect(html).not.toContain("All required proof is captured");
  });

  it("celebrates only a REAL all-captured state (compiled requirements exist)", () => {
    const html = render({
      room: "proof",
      workPackages: [
        {
          id: "wp1",
          jobId: "j1",
          title: "Reception power",
          scopeClauseIds: [],
          boqLineRefs: [],
          taskRefs: [],
          requiredEvidence: [{ id: "re1", label: "Photo", kind: "photo" }],
          order: 0,
        } as unknown as WorkPackage,
      ],
      owedProof: [],
    });
    expect(html).toContain("All required proof is captured");
  });

  it("lists owed proof at its authored granularity with the area named", () => {
    const owed: OwedProofItem[] = [
      {
        workPackageId: "wp1",
        workPackageTitle: "Reception power",
        requirement: { id: "re1", label: "Covered-work photo", kind: "photo" },
        areaIds: ["a1"],
      },
    ];
    const html = render({ room: "proof", owedProof: owed });
    expect(html).toContain("Covered-work photo");
    expect(html).toContain("Reception power");
    expect(html).toContain(">Needs photo<");
  });

  it("keeps the circuit schedule + photos reachable only when they exist", () => {
    const none = render({ room: "proof" });
    expect(none).not.toContain("Circuit schedule");
    expect(none).not.toContain("All photos");
    const some = render({
      room: "proof",
      hasCircuitSchedule: true,
      circuitBoards: [{ circuits: [] }],
      evidenceItems: [{ id: "ev1" } as never],
    });
    expect(some).toContain("Circuit schedule");
    expect(some).toContain('href="/phil/jobs/j1/circuit-schedule"');
    expect(some).toContain("All photos");
    expect(some).toContain('href="/phil/jobs/j1/photos"');
  });
});

describe("SITE room", () => {
  it("renders the Plans row (current-only wording) and the real site card open", () => {
    const html = render({ room: "site" });
    expect(html).toContain(">Plans<");
    expect(html).toContain('href="/phil/jobs/j1/plans"');
    expect(html).toContain("current revisions only");
    // The job HAS site context (address) → the site card renders, open, with
    // only its real fields. No contacts → no Who to call.
    expect(html).toContain("Site details");
    expect(html).toContain("40 Kent St");
    expect(html).not.toContain("Who to call");
  });

  it("omits the site card entirely when the job has no site context", () => {
    const bare = {
      id: "j1",
      name: "Bare job",
      status: "active",
      areaGroups: [],
    } as unknown as Job;
    const html = render({ room: "site", job: bare, groups: [] });
    expect(html).not.toContain("Site details");
  });

  it("shows Who to call only with real categorised contacts", () => {
    const html = render({
      room: "site",
      contacts: [
        {
          id: "c1",
          category: "project",
          name: "Dave Nguyen",
          role: "Site super",
          phone: "0400 000 000",
        } as never,
      ],
    });
    expect(html).toContain("Who to call");
    expect(html).toContain("Dave Nguyen");
    expect(html).toContain('data-testid="contact-call"');
  });
});
