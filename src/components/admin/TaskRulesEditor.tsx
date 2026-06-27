"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { validateRules, type TaskRule } from "@/domains/jobs/task-rules";

/**
 * Task-generation rules editor (#224) — the "small settings surface" the AC
 * calls for. A client island over `GET /api/task-rules` + `POST
 * ?action=save` (admin-only) and `GET /api/job-types?action=list` for the job
 * type picker. Rules are edited as a block and saved as one full-array replace
 * (the server normalises + mints ids). Task lists are entered one-per-line.
 *
 * Validity mirrors the server (validateRules is advisory; the POST is
 * authoritative). The builder's "Generate tasks" consumes these rules.
 */

interface DraftRule {
  key: string;
  id?: string;
  jobType: string; // "" = any
  areaPattern: string;
  roughInText: string; // one task name per line
  fitOffText: string;
}

interface JobTypeOption {
  id: string;
  name: string;
}

type LoadState = "loading" | "ready" | "error";

let keyCounter = 0;
const nextKey = () => `tr-draft-${++keyCounter}`;

const linesToNames = (text: string): string[] =>
  text.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

const namesToLines = (names: ReadonlyArray<string>): string => (names ?? []).join("\n");

function toDraft(rule: TaskRule): DraftRule {
  return {
    key: rule.id,
    id: rule.id,
    jobType: rule.jobType ?? "",
    areaPattern: rule.areaPattern ?? "",
    roughInText: namesToLines(rule.roughIn),
    fitOffText: namesToLines(rule.fitOff),
  };
}

function toRule(d: DraftRule): TaskRule {
  return {
    id: d.id ?? "",
    jobType: d.jobType.trim() === "" ? null : d.jobType.trim(),
    areaPattern: d.areaPattern.trim() === "" ? null : d.areaPattern.trim(),
    roughIn: linesToNames(d.roughInText),
    fitOff: linesToNames(d.fitOffText),
  };
}

export function TaskRulesEditor() {
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<DraftRule[]>([]);
  const [jobTypes, setJobTypes] = useState<JobTypeOption[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [rulesRes, typesRes] = await Promise.all([
          fetch("/api/task-rules", { cache: "no-store" }),
          fetch("/api/job-types?action=list", { cache: "no-store" }),
        ]);
        if (!rulesRes.ok) throw new Error(`rules ${rulesRes.status}`);
        const rulesBody = await rulesRes.json();
        const typesBody = typesRes.ok ? await typesRes.json() : { jobTypes: [] };
        if (!alive) return;
        const rules: TaskRule[] = Array.isArray(rulesBody.rules) ? rulesBody.rules : [];
        setItems(rules.map(toDraft));
        setJobTypes(Array.isArray(typesBody.jobTypes) ? typesBody.jobTypes : []);
        setState("ready");
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const patch = (key: string, p: Partial<DraftRule>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...p } : i)));
    setDirty(true);
    setSavedAt(null);
  };

  const validationErrors = useMemo(() => validateRules(items.map(toRule)), [items]);
  const valid = validationErrors.length === 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/task-rules?action=save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: items.map(toRule) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.error) || `Save failed (${res.status})`);
      }
      const body = await res.json();
      const rules: TaskRule[] = Array.isArray(body.rules) ? body.rules : [];
      setItems(rules.map(toDraft));
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") {
    return (
      <Card>
        <CardTitle>Task generation rules</CardTitle>
        <CardDescription className="mt-1">Loading…</CardDescription>
      </Card>
    );
  }
  if (state === "error") {
    return (
      <Card className="border-amber-200 bg-amber-50" role="alert">
        <CardTitle>Couldn&rsquo;t load the rules</CardTitle>
        <CardDescription className="text-amber-900">
          Reload the page to try again.
        </CardDescription>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Task generation rules</CardTitle>
            <CardDescription className="mt-1">
              When you press <strong>Generate tasks</strong> in the builder, every
              empty area that matches a rule is filled with its task lists. Leave a
              job type or area pattern blank to match anything. Area patterns match
              by name (case-insensitive substring — &ldquo;bath&rdquo; matches
              &ldquo;Main Bathroom&rdquo;). One task per line.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="secondary"
            data-testid="rule-add"
            onClick={() => {
              setItems((prev) => [
                ...prev,
                { key: nextKey(), jobType: "", areaPattern: "", roughInText: "", fitOffText: "" },
              ]);
              setDirty(true);
            }}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add rule
          </Button>
        </div>

        {error ? (
          <p role="alert" className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </p>
        ) : null}
      </Card>

      {items.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted">
            No rules yet. Add one to capture a repeatable pattern (e.g.
            &ldquo;every bathroom gets these rough-in tasks&rdquo;).
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {items.map((item, idx) => (
            <li key={item.key}>
              <Card>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs uppercase tracking-wide text-text-muted">Job type</span>
                    <select
                      value={item.jobType}
                      onChange={(e) => patch(item.key, { jobType: e.target.value })}
                      className="mt-1 h-9 w-full rounded-card border border-border bg-surface px-2 text-sm"
                      data-testid={`rule-jobtype-${idx}`}
                    >
                      <option value="">Any job type</option>
                      {jobTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs uppercase tracking-wide text-text-muted">Area name contains</span>
                    <input
                      value={item.areaPattern}
                      onChange={(e) => patch(item.key, { areaPattern: e.target.value })}
                      placeholder="e.g. bath (blank = any area)"
                      className="mt-1 h-9 w-full rounded-card border border-border bg-surface px-2 text-sm"
                      data-testid={`rule-pattern-${idx}`}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs uppercase tracking-wide text-text-muted">Rough-in tasks</span>
                    <textarea
                      value={item.roughInText}
                      onChange={(e) => patch(item.key, { roughInText: e.target.value })}
                      rows={4}
                      placeholder={"One task per line"}
                      className="mt-1 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm"
                      data-testid={`rule-rough-${idx}`}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs uppercase tracking-wide text-text-muted">Fit-off tasks</span>
                    <textarea
                      value={item.fitOffText}
                      onChange={(e) => patch(item.key, { fitOffText: e.target.value })}
                      rows={4}
                      placeholder={"One task per line"}
                      className="mt-1 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm"
                      data-testid={`rule-fit-${idx}`}
                    />
                  </label>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setItems((prev) => prev.filter((i) => i.key !== item.key));
                      setDirty(true);
                    }}
                    aria-label="Remove rule"
                  >
                    Remove
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy || !dirty || !valid} data-testid="rules-save">
          {busy ? "Saving…" : "Save rules"}
        </Button>
        {savedAt ? <span className="text-xs text-state-success">Saved.</span> : null}
        {!valid ? (
          <span className="text-xs text-text-muted">Every rule needs at least one task.</span>
        ) : null}
      </div>
    </div>
  );
}
