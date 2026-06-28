"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { validateJobTypeName } from "@/domains/platform/policy-schema";

/**
 * Job-types section (#222) — a self-fetching client island over
 * `api/job-types.js`, supporting EXACTLY the four actions it exposes:
 *   GET    ?action=list                → { jobTypes: [{ id, name }] }
 *   POST   ?action=create  { name }    → { jobType }
 *   POST   ?action=update  { id, name }→ { jobType }
 *   POST   ?action=delete  { id }      → { ok } | 409 (in use by jobs)
 *
 * No invented capabilities. Each row saves INDEPENDENTLY (no mega-form). The
 * server's 409 delete-guard ("in use by one or more jobs") is surfaced as a
 * friendly per-row message rather than a raw error. States: loading / loaded /
 * empty (a real empty state, NOT an error) / error / per-action save-failure.
 *
 * `canEdit` (admin tier, computed server-side) gates the create/rename/delete
 * controls — the endpoint is admin-tier server-side, so the page gate already
 * admits exactly the writers, but a read-only viewer never sees dead buttons.
 */

type LoadState = "loading" | "ready" | "error";

interface JobType {
  id: string;
  name: string;
}

function parseList(json: unknown): JobType[] | null {
  if (!json || typeof json !== "object") return null;
  const arr = (json as { jobTypes?: unknown }).jobTypes;
  if (!Array.isArray(arr)) return null;
  const out: JobType[] = [];
  for (const t of arr) {
    if (t && typeof t === "object") {
      const { id, name } = t as { id?: unknown; name?: unknown };
      if (typeof id === "string" && typeof name === "string") out.push({ id, name });
    }
  }
  return out;
}

export function JobTypesSection({ canEdit }: { canEdit: boolean }) {
  const [load, setLoad] = useState<LoadState>("loading");
  const [types, setTypes] = useState<JobType[]>([]);
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // One row in flight at a time, keyed by id ("__new" for the add form).
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  async function refresh(): Promise<JobType[] | null> {
    const res = await fetch("/api/job-types?action=list", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return parseList(await res.json());
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await refresh();
        if (!alive) return;
        if (!list) {
          setLoad("error");
          return;
        }
        setTypes(list);
        setLoad("ready");
      } catch {
        if (alive) setLoad("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function setError(key: string, msg: string | null) {
    setRowError((prev) => {
      const next = { ...prev };
      if (msg === null) delete next[key];
      else next[key] = msg;
      return next;
    });
  }

  async function reload() {
    const list = await refresh();
    if (list) setTypes(list);
  }

  async function create() {
    const name = validateJobTypeName(newName);
    if (!name.ok) {
      setError("__new", name.error);
      return;
    }
    setBusy("__new");
    setError("__new", null);
    try {
      const res = await fetch("/api/job-types?action=create", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.error) || `Couldn't add (${res.status})`);
      }
      setNewName("");
      await reload();
    } catch (e) {
      setError("__new", e instanceof Error ? e.message : "Couldn't add the job type");
    } finally {
      setBusy(null);
    }
  }

  async function rename(id: string) {
    const draft = drafts[id] ?? "";
    const name = validateJobTypeName(draft);
    if (!name.ok) {
      setError(id, name.error);
      return;
    }
    setBusy(id);
    setError(id, null);
    try {
      const res = await fetch("/api/job-types?action=update", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: name.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.error) || `Couldn't rename (${res.status})`);
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await reload();
    } catch (e) {
      setError(id, e instanceof Error ? e.message : "Couldn't rename");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError(id, null);
    try {
      const res = await fetch("/api/job-types?action=delete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.status === 409) {
        // The server's delete-guard: a type still attached to a job.
        setError(
          id,
          "This job type is used by one or more jobs, so it can't be deleted. Re-type those jobs first.",
        );
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.error) || `Couldn't delete (${res.status})`);
      }
      await reload();
    } catch (e) {
      setError(id, e instanceof Error ? e.message : "Couldn't delete");
    } finally {
      setBusy(null);
    }
  }

  if (load === "loading") {
    return (
      <div data-testid="job-types-loading" className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-11 animate-pulse rounded-card border border-border bg-surface-subtle"
          />
        ))}
      </div>
    );
  }

  if (load === "error") {
    return (
      <div
        data-testid="job-types-error"
        role="alert"
        className="rounded-card border-l-2 border-l-state-danger bg-surface-raised p-4 text-sm text-text"
      >
        {"We couldn't load the job types right now. Refresh to try again."}
      </div>
    );
  }

  return (
    <div data-testid="job-types-panel" className="space-y-4">
      {types.length === 0 ? (
        <p data-testid="job-types-empty" className="text-sm text-text-muted">
          No job types yet. Add one below (e.g. &ldquo;Domestic&rdquo;,
          &ldquo;Commercial&rdquo;) — they label jobs and seed the
          task-generation rules.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="job-types-list">
          {types.map((t) => {
            const draft = drafts[t.id];
            const editing = draft !== undefined;
            const err = rowError[t.id];
            const rowBusy = busy === t.id;
            return (
              <li
                key={t.id}
                className="rounded-card border border-border bg-surface-raised p-3"
              >
                <div className="flex items-center gap-2">
                  {editing && canEdit ? (
                    <input
                      data-testid={`job-type-name-${t.id}`}
                      value={draft}
                      disabled={rowBusy}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))
                      }
                      className="h-9 flex-1 rounded-card border border-border bg-surface px-2 text-sm disabled:opacity-60"
                    />
                  ) : (
                    <span className="flex-1 text-sm text-text">{t.name}</span>
                  )}

                  {canEdit ? (
                    editing ? (
                      <>
                        <Button
                          size="sm"
                          data-testid={`job-type-save-${t.id}`}
                          onClick={() => rename(t.id)}
                          disabled={rowBusy}
                        >
                          {rowBusy ? "Saving…" : "Save"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setDrafts((prev) => {
                              const next = { ...prev };
                              delete next[t.id];
                              return next;
                            });
                            setError(t.id, null);
                          }}
                          disabled={rowBusy}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          data-testid={`job-type-edit-${t.id}`}
                          onClick={() =>
                            setDrafts((prev) => ({ ...prev, [t.id]: t.name }))
                          }
                          disabled={rowBusy}
                        >
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`job-type-delete-${t.id}`}
                          onClick={() => remove(t.id)}
                          disabled={rowBusy}
                          aria-label={`Delete ${t.name}`}
                        >
                          {rowBusy ? "…" : "Delete"}
                        </Button>
                      </>
                    )
                  ) : null}
                </div>
                {err ? (
                  <p
                    role="alert"
                    data-testid={`job-type-error-${t.id}`}
                    className="mt-2 text-xs text-state-danger"
                  >
                    {err}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit ? (
        <div className="border-t border-border pt-4">
          <label htmlFor="new-job-type" className="block text-sm font-medium text-text">
            Add a job type
          </label>
          <div className="mt-2 flex items-center gap-2">
            <input
              id="new-job-type"
              data-testid="job-type-new-name"
              value={newName}
              disabled={busy === "__new"}
              placeholder="e.g. Domestic"
              onChange={(e) => {
                setNewName(e.target.value);
                setError("__new", null);
              }}
              className="h-9 flex-1 rounded-card border border-border bg-surface px-2 text-sm disabled:opacity-60"
            />
            <Button
              data-testid="job-type-add"
              onClick={create}
              disabled={busy === "__new" || newName.trim() === ""}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {busy === "__new" ? "Adding…" : "Add"}
            </Button>
          </div>
          {rowError["__new"] ? (
            <p role="alert" data-testid="job-type-new-error" className="mt-1 text-xs text-state-danger">
              {rowError["__new"]}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-text-muted">
          Read-only — only office admins can change job types.
        </p>
      )}
    </div>
  );
}
