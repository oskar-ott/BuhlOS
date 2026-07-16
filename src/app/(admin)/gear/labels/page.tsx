import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { GearListResponseSchema } from "@/domains/gear/schema";
import type { GearAsset } from "@/domains/gear/types";
import { assetScanUrl } from "@/domains/gear/scan-url";
import { encodeQr, qrToSvg } from "@/domains/gear/qr";
import { typeLabel } from "@/domains/gear/format";
import { LabelSheetToolbar } from "@/components/admin/LabelSheetToolbar";
import "./labels.css";

export const dynamic = "force-dynamic";

/**
 * /gear/labels — #303 printable A4 QR label sheet.
 *
 * A PRINT DOCUMENT (browser print → cut → stick), deliberately chromeless: no
 * AdminShell so the office prints clean labels, not admin sidebar ink. Listed in
 * check-shell-contract.js SHELL_EXEMPT + docs/route-ownership.md §8.1, matching
 * the /itps/pack + /claims/print precedent.
 *
 * Each label carries:
 *   - a QR encoding the ABSOLUTE production scan URL (/phil/gear/scan?asset=<id>) —
 *     the id, never state, so reprints stay valid forever (src/domains/gear/scan-url.ts);
 *   - the asset name + identifier UNDER the code, so a human can match sticker to
 *     tool without scanning (the operator context in the #303 audit).
 *
 * The QR is generated server-side (pure, no dependency, no client JS) so the
 * page prints even with scripting off. `?ids=a,b,c` narrows to a selection
 * (the register's "Print labels" passes the visible set); no `ids` prints the
 * whole in-service register.
 */
export default async function GearLabelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/gear/labels");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("gear", session))) {
    notFound();
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : "";

  const { assets, fetchError } = await loadAssets(raw);

  // Narrow to a selection if `?ids=` is present (register "Print labels" passes
  // the currently-visible set). Preserve register order; ignore unknown ids.
  const idsParam = sp.ids;
  const selectedIds =
    typeof idsParam === "string" && idsParam.trim()
      ? new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean))
      : null;

  // Only in-service assets get labels — a retired tool's sticker would claim to.
  const printable = assets
    .filter((a) => !a.archived)
    .filter((a) => (selectedIds ? selectedIds.has(a.id) : true));

  const labels = printable.map((a) => {
    const url = assetScanUrl(origin, a.id);
    // Guard against an impossible payload (shouldn't happen for a real id).
    let svg: string | null = null;
    try {
      svg = qrToSvg(encodeQr(url), { margin: 2 });
    } catch {
      svg = null;
    }
    return { asset: a, svg };
  });

  return (
    <main className="labels-root">
      <LabelSheetToolbar count={labels.length} />

      {fetchError ? (
        <p className="labels-error" role="alert">
          Couldn’t load the register: {fetchError}. Refresh to try again.
        </p>
      ) : labels.length === 0 ? (
        <p className="labels-empty">
          {selectedIds
            ? "None of the selected assets are in service, so there’s nothing to print."
            : "No in-service assets to label yet. Add gear to the register first."}
        </p>
      ) : (
        <section className="labels-grid" aria-label="QR labels">
          {labels.map(({ asset, svg }) => (
            <LabelCard key={asset.id} asset={asset} svg={svg} />
          ))}
        </section>
      )}
    </main>
  );
}

function LabelCard({ asset, svg }: { asset: GearAsset; svg: string | null }) {
  return (
    <article className="label-card">
      <div className="label-qr">
        {svg ? (
          // Server-generated inline SVG — no client JS, prints crisp.
          <span dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <span className="label-qr-fallback">no code</span>
        )}
      </div>
      <div className="label-meta">
        <p className="label-name">{asset.name}</p>
        <p className="label-sub">
          {typeLabel(asset.type)}
          {asset.identifier ? ` · ${asset.identifier}` : ""}
        </p>
      </div>
    </article>
  );
}

async function loadAssets(cookieValue: string | undefined): Promise<{
  assets: ReadonlyArray<GearAsset>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/assets`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { assets: [], fetchError: `API returned ${res.status}` };
    const parsed = GearListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { assets: [], fetchError: "Unexpected response shape" };
    return { assets: parsed.data.assets, fetchError: null };
  } catch (err) {
    return { assets: [], fetchError: err instanceof Error ? err.message : "Network error" };
  }
}
