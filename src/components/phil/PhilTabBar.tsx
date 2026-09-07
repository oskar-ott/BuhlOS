"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import {
  Calendar,
  Briefcase,
  Camera,
  ChevronRight,
  Clock,
  Hammer,
  Map as RoomMapIcon,
  MapPin,
  MoreHorizontal,
  ShieldCheck,
  Wrench,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { PhilCaptureLauncher, type IncomingCapturePhoto } from "./PhilCaptureLauncher";
import {
  philJobDetailId,
  launchableJobs,
  recentShortcutJobs,
  type LaunchableJob,
} from "./philCapture";
import {
  usePhilJobRoomsBarBinding,
  type PhilJobRoomsBarBinding,
} from "./philJobRoomsBar";
import type { PhilJobRoom } from "./philJobRooms";
import { useLongPress } from "./useLongPress";
import { usePhilChromeHint } from "./philChromeHint";
import { readPhilChromeMemory, rememberPhilChrome } from "./philChromeMemory";
import { readJobListPrefs } from "./jobListPrefs";
import { PhilShortcutSheet } from "./PhilShortcutSheet";
import { listJobs } from "@/domains/jobs/client";

interface Tab {
  label: string;
  href: Route;
  icon: typeof Calendar;
  /** Path prefix(es) that mark this tab as active. */
  activeFor: ReadonlyArray<string>;
}

/**
 * Phil bottom tabs — a 4-tab + centre Capture FAB layout:
 *
 *   Today  → /phil/my-day  (the hours loop)
 *   Jobs   → /phil/jobs    (jobs + per-job detail)
 *   [FAB]  → Capture       (global capture launcher — opens from anywhere)
 *   Gear   → /phil/gear    (my gear: return / report damaged / missing)
 *   More   → /v2/phil      (profile menu lands later)
 *
 * The centre Capture FAB replaces the old non-working "Snag" UC tab.
 * Capture is the universal field action: a worker can start a photo
 * capture from Today or Gear in one or two taps rather than opening a
 * job and scrolling to the mid-page Capture block. The launcher routes
 * to the existing, fully-wired CaptureSheet — no new persistence path.
 *
 * Long-press shortcut (#146, P14 — faster access to what a worker repeats):
 * holding the FAB opens a thumb-reachable sheet of the worker's last 2-3 recent
 * jobs (from #145's readJobListPrefs), each a one-tap "capture straight into
 * this job". It is purely ADDITIVE (P10): the plain TAP is unchanged — it still
 * fires the camera synchronously inside the user gesture (iOS file-input rule),
 * and the long-press only suppresses the synthetic click that follows a
 * completed hold. With no valid recents the sheet never opens — the hold falls
 * through to the normal camera flow (P7 — never a fabricated recent).
 *
 * Active tab indicator (doc 27 §7.1): brand-yellow dot below the icon +
 * label colour change.
 *
 * Sharpened mode (phil_sharpened, dark — the field-surface redesign): the
 * right slots become Hours(/phil/hours) · Gear(/phil/gear); More leaves the
 * bar (account moves to the PhilHeader avatar → /v2/phil) and the active
 * indicator becomes a 3px yellow TOP underline. The FAB, testids, camera
 * behaviour and long-press recents are identical in both modes.
 */
const LEFT_TABS: ReadonlyArray<Tab> = [
  { label: "Today", href: "/phil/my-day", icon: Calendar, activeFor: ["/phil/my-day"] },
  { label: "Jobs", href: "/phil/jobs", icon: Briefcase, activeFor: ["/phil/jobs"] },
];

const RIGHT_TABS: ReadonlyArray<Tab> = [
  { label: "Gear", href: "/phil/gear", icon: Wrench, activeFor: ["/phil/gear"] },
  { label: "More", href: "/v2/phil", icon: MoreHorizontal, activeFor: ["/v2/phil"] },
];

// Sharpened right slots (phil_sharpened, dark): Hours joins the bar and
// More/(/v2/phil) leaves it — account moves to the header avatar (PhilHeader),
// which keeps /v2/phil reachable so the approved-href contract still lists it.
// Left slots (Today · Jobs) and the centre Capture FAB are shared with the
// default bar. Parsed by scripts/check-route-ownership.js like LEFT_TABS.
const SHARPENED_RIGHT_TABS: ReadonlyArray<Tab> = [
  { label: "Hours", href: "/phil/hours", icon: Clock, activeFor: ["/phil/hours"] },
  { label: "Gear", href: "/phil/gear", icon: Wrench, activeFor: ["/phil/gear"] },
];

function isTabActive(tab: Tab, pathname: string): boolean {
  return tab.activeFor.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// ── In-job room tabs (phil_job_rooms, dark — the filed #133 experiment) ─────
// While a job screen has REGISTERED a rooms binding (philJobRoomsBar), the four
// flanking slots rebind to the job's rooms: Now · Work · [Capture] · Proof ·
// Site. They are IN-PAGE tabs (buttons driving the job screen's client state),
// not route links — the guard's approved-href contract is untouched — and the
// centre Capture FAB, its camera input and the launcher are IDENTICAL in both
// modes. Nothing registered (every screen today; the job screen while the flag
// is off) ⇒ this list never renders and the bar is byte-identical.
interface RoomTabDef {
  room: PhilJobRoom;
  label: string;
  icon: typeof Zap;
}

const LEFT_ROOM_TABS: ReadonlyArray<RoomTabDef> = [
  { room: "now", label: "Now", icon: Zap },
  { room: "work", label: "Work", icon: Hammer },
];

const RIGHT_ROOM_TABS: ReadonlyArray<RoomTabDef> = [
  { room: "proof", label: "Proof", icon: ShieldCheck },
  { room: "site", label: "Site", icon: RoomMapIcon },
];

/** Live badge count for a room tab — real derived counts from the binding
 *  (needs-you / blocked / proof owed); Site carries none. Never invented. */
function roomBadgeCount(room: PhilJobRoom, binding: PhilJobRoomsBarBinding): number {
  switch (room) {
    case "now":
      return binding.badges.now;
    case "work":
      return binding.badges.work;
    case "proof":
      return binding.badges.proof;
    default:
      return 0;
  }
}

/**
 * One in-job room tab. Visuals follow the sharpened tab language (3px yellow
 * top underline, navy active icon/label) — rooms only exist inside the
 * sharpened package. The badge is the #133 criterion instrumentation
 * ("critical state is never hidden behind navigation"): a navy count pill,
 * red on Now (the needs-you signal is the critical one). Tapping the ACTIVE
 * tab pops its room back to the root (the binding owns that semantics).
 */
function RoomTab({
  tab,
  binding,
}: {
  tab: RoomTabDef;
  binding: PhilJobRoomsBarBinding;
}) {
  const Icon = tab.icon;
  const isActive = binding.active === tab.room;
  const badge = roomBadgeCount(tab.room, binding);
  return (
    <button
      type="button"
      data-testid={`phil-room-tab-${tab.room}`}
      aria-current={isActive ? "true" : undefined}
      aria-label={badge > 0 ? `${tab.label} — ${badge} flagged` : tab.label}
      onClick={() => binding.onSelect(tab.room)}
      className="relative flex min-h-[44px] flex-1 flex-col items-center justify-center"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-x-4 top-0 h-[3px] rounded-b-pill",
          isActive ? "bg-accent-yellow" : "bg-transparent",
        )}
      />
      <span className="relative flex flex-col items-center justify-center gap-0.5">
        <span className="relative">
          <Icon
            aria-hidden="true"
            className={cn("h-5 w-5", isActive ? "text-brand-navy" : "text-text-muted")}
          />
          {badge > 0 ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute -right-3 -top-1.5 min-w-[18px] rounded-pill px-1 text-center text-[12px] font-bold leading-[18px] text-white",
                tab.room === "now" ? "bg-state-danger" : "bg-brand-navy",
              )}
            >
              {badge}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "text-[12px] uppercase tracking-wider",
            isActive ? "font-semibold text-brand-navy" : "font-medium text-text-muted",
          )}
        >
          {tab.label}
        </span>
      </span>
    </button>
  );
}

function TabLink({
  tab,
  pathname,
  sharpened = false,
}: {
  tab: Tab;
  pathname: string;
  /** Sharpened visual: 3px yellow TOP underline instead of the under-label dot. */
  sharpened?: boolean;
}) {
  const Icon = tab.icon;
  const isActive = isTabActive(tab, pathname);
  if (sharpened) {
    return (
      <PhilOfflineLink
        href={tab.href}
        aria-current={isActive ? "page" : undefined}
        className="relative flex flex-1 flex-col items-center justify-center"
      >
        {/* Active tab = 3px yellow top underline (sharpened §1 nav). */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-x-4 top-0 h-[3px] rounded-b-pill",
            isActive ? "bg-accent-yellow" : "bg-transparent",
          )}
        />
        <span className="flex flex-col items-center justify-center gap-0.5">
          <Icon
            aria-hidden="true"
            className={cn("h-5 w-5", isActive ? "text-brand-navy" : "text-text-muted")}
          />
          <span
            className={cn(
              "text-[12px] uppercase tracking-wider",
              isActive ? "font-semibold text-brand-navy" : "font-medium text-text-muted",
            )}
          >
            {tab.label}
          </span>
        </span>
      </PhilOfflineLink>
    );
  }
  return (
    <PhilOfflineLink
      href={tab.href}
      aria-current={isActive ? "page" : undefined}
      className="flex flex-1 flex-col items-center justify-center"
    >
      <span className="flex flex-col items-center justify-center gap-0.5">
        <Icon
          aria-hidden="true"
          className={cn("h-5 w-5", isActive ? "text-brand-navy" : "text-text-muted")}
        />
        <span
          className={cn(
            "text-[12px] uppercase tracking-wider",
            isActive ? "font-semibold text-brand-navy" : "font-medium text-text-muted",
          )}
        >
          {tab.label}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "h-1 w-1 rounded-pill",
            isActive ? "bg-accent-yellow" : "bg-transparent",
          )}
        />
      </span>
    </PhilOfflineLink>
  );
}

interface PhilTabBarProps {
  /**
   * The signed-in worker's id, threaded from the shell (#146). Keys the FAB
   * long-press recents to #145's per-worker readJobListPrefs(userId). Optional:
   * with no id (SSR / a session without one) the long-press simply has no
   * recents and the sheet never opens — the plain camera tap is unchanged.
   */
  userId?: string;
  /**
   * phil_sharpened (dark): render the 5-slot sharpened bar — Today · Jobs ·
   * [Capture] · Hours · Gear, active tab = 3px yellow top underline. Resolved
   * SERVER-SIDE (src/lib/phil/sharpened.ts) and passed as a boolean; when
   * false the bar is byte-identical to the ratified default
   * (Today · Jobs · [Capture] · Gear · More). `undefined` (a flag-less
   * render such as a `loading.tsx` skeleton) consults the chrome memory
   * POST-MOUNT (philChromeMemory.ts), then the request's chrome hint
   * (philChromeHint.tsx — cookie-fed and SSR-safe, so a COLD app open's
   * skeleton keeps the remembered bar too); explicit booleans always win
   * and refresh that memory. Behavioural change to the ratified Phil
   * package — the flag flips only via governance (P15).
   */
  sharpened?: boolean;
  /**
   * phil_job_rooms, server-resolved by the JOB page (via PhilShell): the rooms
   * takeover WILL register on this route, so render the ROOM slots from the
   * first paint instead of flashing the global tabs until hydration — a
   * mis-tap on Hours/Gear in that window exits the job. Until the real
   * binding arrives the room buttons no-op (they're in-page tabs) and carry
   * no badges (counts are client-derived — never invented, P7). `undefined`
   * falls back to the remembered phil_job_rooms flag (memory post-mount, the
   * chrome hint during SSR) AND the pathname being exactly a job-detail
   * route, so the job loading skeleton keeps the room bar instead of
   * flashing the global tabs (#133 mis-tap) — cold deep links included.
   */
  roomsActive?: boolean;
  /**
   * The viewer's phil_job_rooms flag, passed by NON-job pages purely to warm
   * the chrome memory (they resolve philSharpenedFlags anyway) — so a later
   * navigation INTO a job renders the room bar during the skeleton. Never
   * changes this bar's own render; `undefined` leaves the memory write to
   * `roomsActive`.
   */
  jobRoomsEnabled?: boolean;
}

/** Pre-hydration stand-in for the job screen's rooms binding: the job screen
 *  always starts on Now; badges absent (0) until the real counts derive. */
const PENDING_ROOMS_BINDING: PhilJobRoomsBarBinding = {
  active: "now",
  badges: { now: 0, work: 0, proof: 0 },
  onSelect: () => {},
};

export function PhilTabBar({
  userId = "",
  sharpened,
  roomsActive,
  jobRoomsEnabled,
}: PhilTabBarProps) {
  const pathname = usePathname() ?? "";
  // The job id when we're exactly on a job-detail route (/phil/jobs/<id>) —
  // used by the FAB (capture preselect) and the rooms-memory fallback below.
  const currentJobId = philJobDetailId(pathname);
  // Mounted gate (see philChromeMemory.ts): the memory fallback applies only
  // after mount so the first client frame matches the server HTML exactly —
  // no hydration mismatch. The chrome HINT is request-scoped and identical
  // on both passes, so it MAY drive SSR — a cold-start skeleton paints the
  // remembered bar from the first byte (philChromeHint.tsx).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Explicit props refresh the memory; undefined keys are no-ops by design.
  // Non-job pages warm jobRooms via jobRoomsEnabled; the job page's explicit
  // roomsActive (= its phil_job_rooms flag) covers it otherwise.
  useEffect(() => {
    rememberPhilChrome({
      sharpened,
      jobRooms: jobRoomsEnabled !== undefined ? jobRoomsEnabled : roomsActive,
    });
  }, [sharpened, jobRoomsEnabled, roomsActive]);
  const memory = readPhilChromeMemory();
  const hint = usePhilChromeHint();
  // Explicit prop → session memory (post-mount; null until server-confirmed)
  // → the request's cookie hint → the ratified default.
  const effectiveSharpened =
    sharpened ?? (mounted ? memory.sharpened : null) ?? hint?.sharpened ?? false;
  const effectiveRoomsActive =
    roomsActive ??
    (((mounted ? memory.jobRooms : null) ?? hint?.jobRooms ?? false) &&
      currentJobId !== null);
  // In-job rooms binding (phil_job_rooms): non-null ONLY while a job screen has
  // registered its rooms — the flanking slots then render room tabs. The FAB
  // and every capture path below run identically in both modes. On the job
  // route the server already KNOWS the takeover is coming (roomsActive), so
  // the room slots render from the first paint with the pending stand-in and
  // the real binding fills badges/handlers when the client registers it.
  const registeredBinding = usePhilJobRoomsBarBinding();
  const roomsBinding =
    registeredBinding ?? (effectiveRoomsActive ? PENDING_ROOMS_BINDING : null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [incoming, setIncoming] = useState<IncomingCapturePhoto | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  // FAB long-press recents sheet (#146). Jobs are fetched lazily on the first
  // hold (then cached) so the bar's normal render stays free of a jobs request.
  const [recentSheetOpen, setRecentSheetOpen] = useState(false);
  const [recentJobs, setRecentJobs] = useState<LaunchableJob[]>([]);
  const launchableCacheRef = useRef<LaunchableJob[] | null>(null);
  const recentReqRef = useRef(0);
  const [preselectFromRecent, setPreselectFromRecent] = useState<string | null>(null);

  // Camera-first: the FAB fires the OS camera in the SAME tap (the input
  // click must stay inside the user-gesture call stack — iOS blocks deferred
  // programmatic file-input clicks) and opens the launcher behind it to
  // receive the shot. Cancelling the camera just leaves the launcher open
  // with its photo button. On a job home the launcher preselects that job as
  // the destination.
  const fireCamera = () => cameraInputRef.current?.click();
  const onCapture = () => {
    fireCamera();
    setLauncherOpen(true);
  };
  const onCameraChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so the same photo can be re-taken back-to-back.
    e.target.value = "";
    if (!file) return;
    seqRef.current += 1;
    setIncoming({ file, seq: seqRef.current });
  };

  // FAB long-press: open the recents shortcut sheet, but ONLY when there are
  // real, still-launchable recents. We read the remembered ids synchronously
  // (localStorage); if none, do nothing — the hold falls through to the normal
  // tap. Otherwise we fetch (and cache) the worker's jobs to drop any stale /
  // unassigned recent, and open the sheet only if something valid survives.
  const onFabLongPress = useCallback(async () => {
    if (!userId) return;
    const recents = readJobListPrefs(userId).recents;
    if (recents.length === 0) return;

    let launchable = launchableCacheRef.current;
    if (!launchable) {
      const seq = ++recentReqRef.current;
      const r = await listJobs();
      if (seq !== recentReqRef.current) return; // a newer hold superseded us
      if (!r.ok) return; // offline / error — fall through to the plain tap
      launchable = launchableJobs(r.data.jobs);
      launchableCacheRef.current = launchable;
    }

    const shortlist = recentShortcutJobs(recents, launchable, 3);
    if (shortlist.length === 0) return; // every recent went stale — no sheet
    setRecentJobs(shortlist);
    setRecentSheetOpen(true);
  }, [userId]);

  const fabLongPress = useLongPress({
    onLongPress: () => void onFabLongPress(),
    // The sheet owns the gesture while it's open — no re-trigger underneath it.
    disabled: recentSheetOpen || launcherOpen,
  });

  // Tapping a recent opens the camera-first launcher preselected to that job.
  const onPickRecent = (jobId: string) => {
    setRecentSheetOpen(false);
    setPreselectFromRecent(jobId);
    fireCamera();
    setLauncherOpen(true);
  };

  return (
    <>
      {/* Always-mounted global camera input — the single source of camera
          shots for the capture launcher (first shot from the FAB tap, repeat
          shots via the launcher's "Add photo"). */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={onCameraChange}
      />
      <nav
        aria-label={roomsBinding ? "Job rooms" : "App tabs"}
        className="sticky bottom-0 flex h-16 shrink-0 items-stretch border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {roomsBinding
          ? LEFT_ROOM_TABS.map((tab) => (
              <RoomTab key={tab.room} tab={tab} binding={roomsBinding} />
            ))
          : LEFT_TABS.map((tab) => (
              <TabLink
                key={tab.href}
                tab={tab}
                pathname={pathname}
                sharpened={effectiveSharpened}
              />
            ))}

        {/* Centre Capture button — the universal field action, present on
            every Phil screen. Lifted above the bar so it reads as primary. */}
        <div className="flex flex-1 flex-col items-center justify-end pb-1">
          <button
            type="button"
            aria-label="Capture"
            aria-haspopup={currentJobId ? undefined : "dialog"}
            // Plain tap is UNCHANGED — fires the camera synchronously in the
            // gesture (iOS file-input requirement). The long-press handlers are
            // pointer-only and never own onClick; they only suppress the
            // synthetic click that follows a COMPLETED hold (#146).
            onClick={onCapture}
            {...fabLongPress}
            className={cn(
              "-mt-6 inline-flex h-14 w-14 select-none items-center justify-center rounded-full",
              "border-4 border-surface bg-accent-yellow text-brand-navy shadow-raised",
              "transition-transform active:scale-95",
              // Stop the OS text-callout / selection menu from racing the hold.
              "[-webkit-touch-callout:none]",
            )}
          />
          <span className="mt-0.5 text-[12px] font-semibold uppercase tracking-wider text-brand-navy">
            Capture
          </span>
        </div>

        {roomsBinding
          ? RIGHT_ROOM_TABS.map((tab) => (
              <RoomTab key={tab.room} tab={tab} binding={roomsBinding} />
            ))
          : (effectiveSharpened ? SHARPENED_RIGHT_TABS : RIGHT_TABS).map((tab) => (
              <TabLink
                key={tab.href}
                tab={tab}
                pathname={pathname}
                sharpened={effectiveSharpened}
              />
            ))}
      </nav>

      {/* FAB long-press: capture straight into a recent job (#146). */}
      <PhilShortcutSheet
        open={recentSheetOpen}
        onClose={() => setRecentSheetOpen(false)}
        title="Capture into a recent job"
        subtitle="Jobs you’ve opened lately — tap one to snap straight into it"
        testId="phil-fab-recents"
      >
        <ul className="space-y-2">
          {recentJobs.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => onPickRecent(job.id)}
                aria-label={`Capture into ${job.name}`}
                className="flex min-h-[56px] w-full items-center gap-3 rounded-card border border-border bg-surface p-3 text-left hover:bg-surface-subtle active:scale-[0.99]"
              >
                <Camera aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-navy" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-sm font-semibold text-text">
                    {job.name}
                  </span>
                  {job.siteAddress ? (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-text-muted">
                      <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{job.siteAddress}</span>
                    </span>
                  ) : null}
                </span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              </button>
            </li>
          ))}
        </ul>
      </PhilShortcutSheet>

      <PhilCaptureLauncher
        open={launcherOpen}
        onClose={() => {
          setLauncherOpen(false);
          setPreselectFromRecent(null);
        }}
        // A recent picked from the long-press sheet preselects that job; else
        // the job home we're on (the unchanged FAB behaviour).
        initialJobId={preselectFromRecent ?? currentJobId}
        incoming={incoming}
        onRequestCamera={fireCamera}
      />
    </>
  );
}
