"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import {
  archiveItpTemplate,
  createItpTemplate,
  duplicateItpTemplate,
  listItpTemplatesWithArchived,
  updateItpTemplate,
} from "@/domains/itp/client";
import { ITP_POINT_TYPES, ITP_WITNESS_ROLES } from "@/domains/itp/schema";
import type { ITPTemplateSummary, ItpTemplatePointDraft } from "@/domains/itp/types";

/**
 * ITP template library (#284) — authoring lived ONLY in the legacy SPA,
 * which the cutover deleted; until this page, templates could not be
 * created or changed at all. Create / edit / duplicate / archive over the
 * existing api/itp-templates.js (no new endpoint).
 *
 * Editing a template NEVER touches attached instances — attach snapshots
 * the points (harness-asserted). Archiving removes it from the attach
 * picker (server now also refuses archived attaches); instances live on.
 *
 * Admin-side surface: "ITP" terminology is fine here — Phil keeps "Checks".
 * The point editor is a plain ordered list (up/down/remove) so sibling
 * issues (hold points, only-if, evidence flags) can extend per-point rows.
 */

interface Props {
  initialTemplates: ReadonlyArray<ITPTemplateSummary>;
  fetchError: string | null;
}

type PointRow = ItpTemplatePointDraft & { key: string };

type Editor =
  | { mode: "create" }
  | { mode: "edit"; template: ITPTemplateSummary }
  | null;

let keyCounter = 0;
const nextKey = () => `p${++keyCounter}`;

function rowsFromTemplate(template: ITPTemplateSummary | null): PointRow[] {
  const points = (template?.points ?? []) as Array<Record<string, unknown>>;
  if (!points.length) {
    return [{ key: nextKey(), label: "", type: "photo", required: true }];
  }
  return points
    .filter((p) => !p.archived)
    .map((p) => ({
      key: nextKey(),
      id: typeof p.id === "string" ? p.id : undefined,
      label: String(p.label ?? ""),
      type: (p.type as PointRow["type"]) ?? "photo",
      required: p.required !== false,
      unit: typeof p.unit === "string" && p.unit ? p.unit : undefined,
      min: typeof p.min === "number" ? p.min : undefined,
      max: typeof p.max === "number" ? p.max : undefined,
      witnessRole: (p.witnessRole as PointRow["witnessRole"]) ?? undefined,
    }));
}

export function ItpTemplateLibrary({ initialTemplates, fetchError }: Props) {
  const router = useRouter();
  const [templates, setTemplates] = useState<ReadonlyArray<ITPTemplateSummary>>(initialTemplates);
  const [editor, setEditor] = useState<Editor>(null);
  const [archiveTarget, setArchiveTarget] = useState<ITPTemplateSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function refresh() {
    const result = await listItpTemplatesWithArchived();
    if (result.ok) setTemplates(result.data.templates);
    router.refresh();
  }

  async function run(label: string, op: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(true);
    setNotice(null);
    const result = await op();
    setBusy(false);
    if (!result.ok) {
      setNotice({ tone: "bad", text: `${label} failed: ${result.error?.message ?? "unknown"}` });
      return false;
    }
    setNotice({ tone: "ok", text: `${label} done.` });
    await refresh();
    return true;
  }

  const live = templates.filter((t) => !t.archived);
  const archived = templates.filter((t) => t.archived);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>ITP templates</CardTitle>
            <CardDescription className="mt-1">
              The company check library. Attach them to jobs from the job&rsquo;s ITP queue;
              editing here never changes checks already attached (they keep their snapshot).
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setEditor({ mode: "create" })} data-testid="template-create-open">
            New template
          </Button>
        </div>
      </Card>

      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardDescription className="text-amber-900">{fetchError}</CardDescription>
        </Card>
      ) : null}

      {notice ? (
        <p
          role="status"
          className={`rounded-card border px-3 py-2 text-sm ${
            notice.tone === "ok" ? "border-state-success text-state-success" : "border-state-danger text-state-danger"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {live.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted">
            No templates yet. Create the first one — e.g. &ldquo;MSB energisation&rdquo; or
            &ldquo;Final fix QA&rdquo; — then attach it to jobs.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {live.map((t) => (
            <li key={t.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-text">{t.name}</p>
                  <p className="text-xs text-text-muted">
                    {t.category ? `${t.category} · ` : ""}
                    {(t.points ?? []).length} point{(t.points ?? []).length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditor({ mode: "edit", template: t })}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run("Duplicate", () => duplicateItpTemplate(t.id))}
                  >
                    Duplicate
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setArchiveTarget(t)}>
                    Archive
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <Card>
          <CardTitle>Archived</CardTitle>
          <ul className="mt-2 space-y-1 text-sm text-text-muted">
            {archived.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <Pill tone="neutral">archived</Pill>
                {t.name}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {editor ? (
        <TemplateEditorSheet
          editor={editor}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={async (payload) => {
            const saved =
              editor.mode === "create"
                ? await run("Create", () => createItpTemplate(payload))
                : await run("Save", () => updateItpTemplate(editor.template.id, payload));
            if (saved) setEditor(null);
          }}
        />
      ) : null}

      {archiveTarget ? (
        <Modal open onClose={() => setArchiveTarget(null)} title={`Archive ${archiveTarget.name}?`} className="max-w-md">
          <div className="space-y-4 text-sm">
            <p className="text-text-muted">
              It leaves the attach picker (the server refuses archived attaches too). Checks
              already attached to jobs keep working — they hold their own snapshot.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setArchiveTarget(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                className="flex-1"
                disabled={busy}
                data-testid="template-archive-confirm"
                onClick={() => {
                  const t = archiveTarget;
                  setArchiveTarget(null);
                  void run("Archive", () => archiveItpTemplate(t.id));
                }}
              >
                Archive
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function TemplateEditorSheet({
  editor,
  busy,
  onClose,
  onSave,
}: {
  editor: NonNullable<Editor>;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: {
    name: string;
    category?: string;
    description?: string;
    points: ItpTemplatePointDraft[];
  }) => void;
}) {
  const base = editor.mode === "edit" ? editor.template : null;
  const [name, setName] = useState(base?.name ?? "");
  const [category, setCategory] = useState(base?.category ?? "");
  const [description, setDescription] = useState(base?.description ?? "");
  const [rows, setRows] = useState<PointRow[]>(() => rowsFromTemplate(base));

  const inputClass = "h-9 w-full rounded-card border border-border bg-surface px-2 text-sm";

  const setRow = (key: string, patch: Partial<PointRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (idx: number, dir: -1 | 1) =>
    setRows((rs) => {
      const next = [...rs];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return rs;
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });

  const valid = name.trim() !== "" && rows.length > 0 && rows.every((r) => r.label.trim() !== "");

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title={editor.mode === "create" ? "New ITP template" : `Edit ${base?.name ?? "template"}`}
      className="max-w-2xl"
    >
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-text-muted">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} data-testid="template-name" />
          </label>
          <label className="block">
            <span className="text-text-muted">Category (optional)</span>
            <input value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass} placeholder="e.g. Electrical" />
          </label>
        </div>
        <label className="block">
          <span className="text-text-muted">Description (optional)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </label>

        <div>
          <h3 className="font-display text-sm uppercase tracking-wider text-text-muted">
            Points · in the order the inspector records them
          </h3>
          <ul className="mt-2 space-y-2">
            {rows.map((row, idx) => (
              <li key={row.key} className="space-y-2 rounded-card border border-border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-5 text-xs text-text-muted">{idx + 1}.</span>
                  <input
                    value={row.label}
                    onChange={(e) => setRow(row.key, { label: e.target.value })}
                    placeholder="What gets checked / recorded?"
                    className="h-9 min-w-[180px] flex-1 rounded-card border border-border bg-surface px-2 text-sm"
                    data-testid={`point-label-${idx}`}
                  />
                  <select
                    value={row.type}
                    onChange={(e) => setRow(row.key, { type: e.target.value as PointRow["type"] })}
                    className="h-9 rounded-card border border-border bg-surface px-2 text-sm"
                    aria-label="Point type"
                  >
                    {ITP_POINT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => move(idx, -1)} disabled={idx === 0} aria-label="Move up">
                      ↑
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => move(idx, 1)} disabled={idx === rows.length - 1} aria-label="Move down">
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                      disabled={rows.length === 1}
                      aria-label="Remove point"
                    >
                      ✕
                    </Button>
                  </div>
                </div>
                {row.type === "value" ? (
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      value={row.unit ?? ""}
                      onChange={(e) => setRow(row.key, { unit: e.target.value || undefined })}
                      placeholder="Unit (e.g. MΩ)"
                      className={inputClass}
                    />
                    <input
                      type="number"
                      value={row.min ?? ""}
                      onChange={(e) => setRow(row.key, { min: e.target.value === "" ? undefined : Number(e.target.value) })}
                      placeholder="Min pass"
                      className={inputClass}
                    />
                    <input
                      type="number"
                      value={row.max ?? ""}
                      onChange={(e) => setRow(row.key, { max: e.target.value === "" ? undefined : Number(e.target.value) })}
                      placeholder="Max pass"
                      className={inputClass}
                    />
                  </div>
                ) : null}
                {row.type === "signoff" ? (
                  <label className="block">
                    <span className="text-xs text-text-muted">Witnessed by</span>
                    <select
                      value={row.witnessRole ?? "admin"}
                      onChange={(e) => setRow(row.key, { witnessRole: e.target.value as PointRow["witnessRole"] })}
                      className={inputClass}
                    >
                      {ITP_WITNESS_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r === "lh" ? "leading hand" : r}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => setRows((rs) => [...rs, { key: nextKey(), label: "", type: "photo", required: true }])}
            data-testid="point-add"
          >
            Add a point
          </Button>
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={busy || !valid}
            data-testid="template-save"
            onClick={() =>
              onSave({
                name: name.trim(),
                category: category.trim() || undefined,
                description: description.trim() || undefined,
                points: rows.map(({ key: _key, ...p }) => ({ ...p, label: p.label.trim() })),
              })
            }
          >
            {busy ? "Saving…" : "Save template"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
