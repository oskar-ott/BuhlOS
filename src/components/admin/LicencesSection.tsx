"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import {
  addLicence,
  licencesFor,
  removeLicence,
  updateLicence,
} from "@/domains/workforce/client";
import {
  credentialStatusLabel,
  credentialToneFor,
  expiryLabel,
  sortCredentials,
} from "@/domains/workforce/service";
import type { Credential, LicenceType } from "@/domains/workforce/types";

/**
 * "Licences & tickets" inside the employee detail drawer (#331). The office
 * records type / number / class / dates; status chips come straight off the
 * server's computed fields. Records key on the users.json userId, so a
 * worker who hasn't finished Phil setup yet has nowhere to hang them —
 * honest note instead.
 */

interface LicencesSectionProps {
  userId: string | null;
  workerName: string;
}

interface FormState {
  id: string | null; // null = adding
  typeId: string;
  label: string;
  number: string;
  licenceClass: string;
  issueDate: string;
  expiryDate: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  typeId: "electrical",
  label: "",
  number: "",
  licenceClass: "",
  issueDate: "",
  expiryDate: "",
};

export function LicencesSection({ userId, workerName }: LicencesSectionProps) {
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [types, setTypes] = useState<LicenceType[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [removing, setRemoving] = useState<Credential | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    (async () => {
      const res = await licencesFor(userId);
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.error.message);
        setCredentials([]);
        return;
      }
      setCredentials(sortCredentials(res.data.credentials));
      setTypes(res.data.types);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) {
    return (
      <section>
        <SectionHeading />
        <p className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
          Licences unlock once {workerName} finishes Phil setup — records hang
          off their worker account.
        </p>
      </section>
    );
  }

  async function reload() {
    if (!userId) return;
    const res = await licencesFor(userId);
    if (res.ok) {
      setCredentials(sortCredentials(res.data.credentials));
      setTypes(res.data.types);
    }
  }

  async function save() {
    if (!form || !userId) return;
    setBusy(true);
    setActionError(null);
    const payload = {
      typeId: form.typeId,
      label: form.typeId === "other" ? form.label : undefined,
      number: form.number.trim() || null,
      licenceClass: form.licenceClass.trim() || null,
      issueDate: form.issueDate || null,
      expiryDate: form.expiryDate || null,
    };
    const res = form.id
      ? await updateLicence({ id: form.id, ...payload })
      : await addLicence({ userId, ...payload });
    setBusy(false);
    if (!res.ok) {
      setActionError(res.error.message);
      return;
    }
    setForm(null);
    await reload();
  }

  async function doRemove() {
    if (!removing) return;
    setBusy(true);
    setActionError(null);
    const res = await removeLicence(removing.id);
    setBusy(false);
    setRemoving(null);
    if (!res.ok) {
      setActionError(res.error.message);
      return;
    }
    await reload();
  }

  const inputClass =
    "h-9 w-full rounded-card border border-border bg-surface px-2 text-sm";

  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <SectionHeading />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setForm(form ? null : { ...EMPTY_FORM })}
          data-testid="licence-add-open"
        >
          Add
        </Button>
      </div>

      {loadError ? (
        <p className="mb-2 text-xs text-text-muted">{loadError}</p>
      ) : null}
      {actionError ? (
        <p
          role="alert"
          className="mb-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
        >
          {actionError}
        </p>
      ) : null}

      {form ? (
        <div className="mb-2 grid gap-2 rounded-card border border-border p-3">
          <div className="grid grid-cols-2 gap-2">
            <select
              value={form.typeId}
              onChange={(e) => setForm({ ...form, typeId: e.target.value })}
              className={inputClass}
              aria-label="Licence type"
              data-testid="licence-type"
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={form.number}
              onChange={(e) => setForm({ ...form, number: e.target.value })}
              placeholder="Licence number"
              className={inputClass}
              aria-label="Licence number"
            />
          </div>
          {form.typeId === "other" ? (
            <input
              type="text"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="What is the ticket?"
              className={inputClass}
              aria-label="Ticket name"
            />
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-text-muted">
              Issued
              <input
                type="date"
                value={form.issueDate}
                onChange={(e) => setForm({ ...form, issueDate: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="block text-xs text-text-muted">
              Expires (blank = doesn&rsquo;t)
              <input
                type="date"
                value={form.expiryDate}
                onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                className={inputClass}
                data-testid="licence-expiry"
              />
            </label>
          </div>
          <input
            type="text"
            value={form.licenceClass}
            onChange={(e) => setForm({ ...form, licenceClass: e.target.value })}
            placeholder="Class / endorsements (optional)"
            className={inputClass}
            aria-label="Class"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={busy || (form.typeId === "other" && !form.label.trim())}
              data-testid="licence-save"
            >
              {form.id ? "Save changes" : "Add licence"}
            </Button>
          </div>
        </div>
      ) : null}

      {credentials === null ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : credentials.length === 0 ? (
        <p className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
          None on file yet. Add the tickets {workerName} holds — expiring ones
          alert the office and the worker before a site audit finds them.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border">
          {credentials.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{c.label}</span>
                  <Pill tone={credentialToneFor(c.status)}>
                    {credentialStatusLabel(c.status)}
                  </Pill>
                </span>
                <span className="block font-mono text-[11px] text-text-muted">
                  {c.number ? `№ ${c.number} · ` : ""}
                  {c.licenceClass ? `${c.licenceClass} · ` : ""}
                  {expiryLabel(c)}
                </span>
              </span>
              <span className="flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setForm({
                      id: c.id,
                      typeId: c.typeId,
                      label: c.typeId === "other" ? c.label : "",
                      number: c.number ?? "",
                      licenceClass: c.licenceClass ?? "",
                      issueDate: c.issueDate ?? "",
                      expiryDate: c.expiryDate ?? "",
                    })
                  }
                >
                  Edit
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(c)}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.label ?? "this record"}?`}
      >
        <p className="text-sm text-text-muted">
          This deletes the record from the register (the audit log keeps the
          trail). If it&rsquo;s a renewal, edit the dates instead.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={doRemove} disabled={busy}>
            Remove record
          </Button>
        </div>
      </Modal>
    </section>
  );
}

function SectionHeading() {
  return (
    <h3 className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
      Licences &amp; tickets
    </h3>
  );
}
