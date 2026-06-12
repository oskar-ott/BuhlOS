"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { listItpTemplates } from "@/domains/itp/client";
import { areaTargets, levelTargets } from "@/domains/itp/attach-targets";
import { ITP_SCOPES } from "@/domains/itp/schema";
import type { AttachITPPayload, ITPScope, ITPTemplateSummary } from "@/domains/itp/types";
import type { Job } from "@/domains/jobs/types";

/**
 * Attach flow for the v2 ITP queue (#387) — restores the capability the
 * legacy cutover deleted (the module-gated panel on admin/job.html was the
 * only UI caller of action=attach; the typed verb sat unused since).
 *
 * Template picker lists GET /api/itp-templates — the server already excludes
 * archived templates from the default list, so they're never offered. Scope
 * targets come from the job structure via attach-targets.ts (the reverse of
 * Phil's resolveScopeName, so attached scopes resolve everywhere). Jobs have
 * no switchboard register (same gap itp-scope.ts documents) — that scope
 * takes a free-text board name and says so, honestly.
 *
 * The server is the security gate (canManageJob + snapshot semantics); this
 * modal is UX. On success the parent applies the server-canonical instance.
 */

const SCOPE_LABELS: Record<ITPScope, string> = {
  job: "Whole job",
  level: "A level / group",
  area: "One area",
  switchboard: "A switchboard",
};

interface Props {
  open: boolean;
  job: Job;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: AttachITPPayload) => void;
}

export function AttachITPModal({ open, job, busy, onClose, onSubmit }: Props) {
  const [templates, setTemplates] = useState<ITPTemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [scope, setScope] = useState<ITPScope>("job");
  const [scopeId, setScopeId] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTemplates(null);
    setTemplatesError(null);
    void listItpTemplates().then((result) => {
      if (cancelled) return;
      if (result.ok) setTemplates(result.data.templates.filter((t) => !t.archived));
      else setTemplatesError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset the target whenever the scope changes — a stale area id on a
  // level-scoped attach would mislabel the instance everywhere.
  useEffect(() => {
    setScopeId("");
  }, [scope]);

  const levels = useMemo(() => levelTargets(job), [job]);
  const areas = useMemo(() => areaTargets(job), [job]);

  const targetsForScope = scope === "level" ? levels : scope === "area" ? areas : null;
  const needsPickedTarget = scope === "level" || scope === "area";
  const ready =
    templateId !== "" &&
    (!needsPickedTarget || scopeId !== "") &&
    (scope !== "switchboard" || scopeId.trim() !== "");

  const selectClass =
    "h-10 w-full rounded-card border border-border bg-surface px-3 text-sm";

  if (!open) return null;

  return (
    <Modal open onClose={onClose} title="Attach a check" className="max-w-lg">
      <div className="space-y-4 text-sm">
        <label className="block">
          <span className="text-text-muted">Template</span>
          {templatesError ? (
            <p className="mt-1 text-state-danger" role="alert">
              Couldn&rsquo;t load templates: {templatesError}
            </p>
          ) : templates === null ? (
            <p className="mt-1 text-text-muted" role="status">
              Loading templates…
            </p>
          ) : templates.length === 0 ? (
            <p className="mt-1 text-text-muted">
              No templates in the library yet — create one under ITP templates first.
            </p>
          ) : (
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className={selectClass}
              data-testid="attach-itp-template"
            >
              <option value="">— Pick a template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.category ? ` (${t.category})` : ""}
                  {t.points ? ` · ${t.points.length} points` : ""}
                </option>
              ))}
            </select>
          )}
        </label>

        <fieldset>
          <legend className="text-text-muted">Where does it apply?</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {ITP_SCOPES.map((s) => (
              <label
                key={s}
                className={`flex cursor-pointer items-center gap-2 rounded-card border px-3 py-2 ${
                  scope === s ? "border-brand-navy" : "border-border"
                }`}
              >
                <input
                  type="radio"
                  name="attach-itp-scope"
                  value={s}
                  checked={scope === s}
                  onChange={() => setScope(s)}
                />
                {SCOPE_LABELS[s]}
              </label>
            ))}
          </div>
        </fieldset>

        {needsPickedTarget ? (
          <label className="block">
            <span className="text-text-muted">
              {scope === "level" ? "Which level / group?" : "Which area?"}
            </span>
            {targetsForScope && targetsForScope.length > 0 ? (
              <select
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
                className={selectClass}
                data-testid="attach-itp-target"
              >
                <option value="">— Pick —</option>
                {targetsForScope.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="mt-1 text-text-muted">
                This job&rsquo;s structure has no {scope === "level" ? "groups" : "areas"} yet —
                build the structure first, or attach to the whole job.
              </p>
            )}
          </label>
        ) : null}

        {scope === "switchboard" ? (
          <label className="block">
            <span className="text-text-muted">Board name / id</span>
            <input
              type="text"
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              maxLength={40}
              placeholder="e.g. DB-G1"
              className={selectClass}
            />
            <p className="mt-1 text-xs text-text-muted">
              There&rsquo;s no switchboard register yet — type the board&rsquo;s name as it
              appears on site; it shows verbatim on the check.
            </p>
          </label>
        ) : null}

        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                templateId,
                scope,
                ...(scope === "job" ? {} : { scopeId: scopeId.trim() }),
              })
            }
            disabled={busy || !ready}
            className="flex-1"
            data-testid="attach-itp-submit"
          >
            {busy ? "Attaching…" : "Attach"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
