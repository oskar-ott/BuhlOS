"use client";

import { useState, type FormEvent } from "react";
import { fetchCertificates, uploadCertificate } from "@/domains/certificates/client";
import {
  CERTIFICATE_TYPES,
  CERTIFICATE_TYPE_LABEL,
  type Certificate,
  type CertificateType,
} from "@/domains/certificates/schema";
import { sortByIssuedDesc } from "@/domains/certificates/sort";

/**
 * The commissioning + certificates register (#231). Upload typed certificates /
 * test sheets / commissioning records with a reference number + issue date; the
 * list sorts newest-issued first. No approval workflow — shelf space the handover
 * pack reads from.
 */
export function CertificatesPanel({
  jobId,
  initialCertificates,
  fetchError,
}: {
  jobId: string;
  initialCertificates: Certificate[];
  fetchError: string | null;
}) {
  const [certificates, setCertificates] = useState<Certificate[]>(initialCertificates);
  const [error, setError] = useState<string | null>(fetchError);
  const [busy, setBusy] = useState(false);

  const [type, setType] = useState<CertificateType>("certificate");
  const [title, setTitle] = useState("");
  const [referenceNo, setReferenceNo] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [file, setFile] = useState<File | null>(null);

  async function refresh() {
    setCertificates((await fetchCertificates(jobId)).certificates);
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault();
    if (!file || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await uploadCertificate(jobId, {
        file,
        type,
        title: title.trim(),
        referenceNo: referenceNo.trim(),
        issuedAt,
      });
      setTitle("");
      setReferenceNo("");
      setIssuedAt("");
      setFile(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const sorted = sortByIssuedDesc(certificates);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Certificates &amp; commissioning</h1>
        <p className="text-sm text-slate-500">
          Certificates of electrical safety, test sheets and commissioning records — typed, with a
          reference number and issue date, so handover (or a callback years later) is a job lookup,
          not a scavenger hunt.
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

      <form onSubmit={onUpload} className="space-y-3 rounded-lg border border-slate-200 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as CertificateType)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {CERTIFICATE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CERTIFICATE_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Certificate of compliance — main switchboard"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Reference no. (optional)</span>
            <input
              value={referenceNo}
              onChange={(e) => setReferenceNo(e.target.value)}
              placeholder="e.g. CCEW-2026-014"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Issue date (optional)</span>
            <input
              type="date"
              value={issuedAt}
              onChange={(e) => setIssuedAt(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
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
          {busy ? "Uploading…" : "Add to register"}
        </button>
      </form>

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-500">No certificates on this job yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Reference</th>
                <th className="px-3 py-2">Issued</th>
                <th className="px-3 py-2">File</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-2">
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                      {CERTIFICATE_TYPE_LABEL[c.type]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-800">{c.title}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">
                    {c.referenceNo || "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-600">{c.issuedAt || "—"}</td>
                  <td className="px-3 py-2">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-900 underline decoration-slate-300 underline-offset-2"
                    >
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
