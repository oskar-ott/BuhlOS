"use client";

import { useState, type FormEvent } from "react";
import { fetchSafetyDocs, uploadSafetyDoc } from "@/domains/safety-docs/client";
import {
  SAFETY_DOC_TYPES,
  SAFETY_DOC_TYPE_LABEL,
  type SafetyDoc,
  type SafetyDocRollup,
  type SafetyDocType,
} from "@/domains/safety-docs/schema";

/**
 * Office side of safety documents (#219). Upload typed + versioned SWMS / SDS /
 * other-safety, and see who across the assigned crew has and hasn't acknowledged
 * the current version. Field workers acknowledge in Phil.
 */
export function SafetyDocsPanel({
  jobId,
  initialDocuments,
  initialRollup,
  fetchError,
}: {
  jobId: string;
  initialDocuments: SafetyDoc[];
  initialRollup: SafetyDocRollup[];
  fetchError: string | null;
}) {
  const [documents, setDocuments] = useState<SafetyDoc[]>(initialDocuments);
  const [rollup, setRollup] = useState<SafetyDocRollup[]>(initialRollup);
  const [error, setError] = useState<string | null>(fetchError);
  const [busy, setBusy] = useState(false);

  const [type, setType] = useState<SafetyDocType>("swms");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [supersedesId, setSupersedesId] = useState("");

  async function refresh() {
    const r = await fetchSafetyDocs(jobId);
    setDocuments(r.documents);
    setRollup(r.rollup ?? []);
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault();
    if (!file || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await uploadSafetyDoc(jobId, {
        file,
        type,
        title: title.trim(),
        supersedesId: supersedesId || undefined,
      });
      setTitle("");
      setFile(null);
      setSupersedesId("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const rollupFor = (docId: string) => rollup.find((r) => r.doc.id === docId);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Safety documents</h1>
        <p className="text-sm text-slate-500">
          SWMS, SDS and other site-safety docs. Workers acknowledge each in Phil; you can see who
          has and hasn&rsquo;t read the current version. Uploading a new version re-sets
          acknowledgement — everyone re-acknowledges.
        </p>
      </header>

      {error && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Upload */}
      <form onSubmit={onUpload} className="space-y-3 rounded-lg border border-slate-200 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as SafetyDocType)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {SAFETY_DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SAFETY_DOC_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Working at Heights — portable ladders"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        {documents.length > 0 && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">New version of (optional)</span>
            <select
              value={supersedesId}
              onChange={(e) => setSupersedesId(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">— a new document —</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {SAFETY_DOC_TYPE_LABEL[d.type]}: {d.title} (v{d.version})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">File (PDF, image or Word)</span>
          <input
            type="file"
            accept=".pdf,.docx,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !file || !title.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Uploading…" : supersedesId ? "Upload new version" : "Upload safety document"}
        </button>
      </form>

      {/* Current docs + rollup */}
      {documents.length === 0 ? (
        <p className="text-sm text-slate-500">No safety documents on this job yet.</p>
      ) : (
        <ul className="space-y-3">
          {documents.map((doc) => {
            const r = rollupFor(doc.id);
            const acked = r?.acknowledged.length ?? 0;
            const out = r?.outstanding.length ?? 0;
            const total = acked + out;
            return (
              <li key={doc.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                      {SAFETY_DOC_TYPE_LABEL[doc.type]}
                    </span>{" "}
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                    >
                      {doc.title}
                    </a>{" "}
                    <span className="text-xs text-slate-500">v{doc.version}</span>
                  </div>
                  <span
                    className={
                      out === 0 && total > 0
                        ? "rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800"
                        : "rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
                    }
                  >
                    {total === 0
                      ? "no crew assigned"
                      : out === 0
                        ? "all acknowledged"
                        : `${acked}/${total} acknowledged`}
                  </span>
                </div>
                {r && total > 0 && (
                  <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <div className="font-medium text-emerald-800">Acknowledged</div>
                      <div className="text-slate-600">
                        {r.acknowledged.length ? r.acknowledged.map((a) => a.name).join(", ") : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="font-medium text-amber-900">Outstanding</div>
                      <div className="text-slate-600">
                        {r.outstanding.length ? r.outstanding.map((o) => o.name).join(", ") : "—"}
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
