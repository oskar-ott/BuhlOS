"use client";

import { useEffect, useState, type FormEvent } from "react";
import { amendMinute, fetchMinutes, recordMinute } from "@/domains/minutes/client";
import type { MinuteEntry } from "@/domains/minutes/schema";
import { JobContactsResponseSchema, type JobContact } from "@/domains/contacts/schema";

/**
 * The per-job meeting-minutes register (#217): record minutes (date, title,
 * attendees, body and/or a PDF), then add stamped, append-only amendments. The
 * original body is NEVER mutated — a correction sits beneath the unchanged
 * original (who/when/note). Newest-first. Honest empty state: a missing body
 * or attachment is stated plainly, never faked.
 */
export function MinutesRegister({
  jobId,
  initialMinutes,
  fetchError,
}: {
  jobId: string;
  initialMinutes: MinuteEntry[];
  fetchError: string | null;
}) {
  const [minutes, setMinutes] = useState<MinuteEntry[]>(initialMinutes);
  const [error, setError] = useState<string | null>(fetchError);
  const [busy, setBusy] = useState(false);

  // Record form.
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [title, setTitle] = useState("");
  const [attendeesText, setAttendeesText] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);

  // Project contacts for the attendee picker.
  const [contacts, setContacts] = useState<JobContact[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Inline amendment composer.
  const [amendId, setAmendId] = useState<string | null>(null);
  const [amendNote, setAmendNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/contacts?jobId=${encodeURIComponent(jobId)}&category=project`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return;
        const parsed = JobContactsResponseSchema.safeParse(await res.json());
        if (!cancelled && parsed.success) setContacts(parsed.data.contacts);
      } catch {
        /* contacts are a convenience; free-text attendees still work */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  async function refresh() {
    setMinutes((await fetchMinutes(jobId)).minutes);
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  function togglePicked(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function fileToDataUrl(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Couldn't read the file"));
      reader.readAsDataURL(f);
    });
  }

  function collectAttendees(): Array<{ name: string; contactId: string | null }> {
    const out: Array<{ name: string; contactId: string | null }> = [];
    for (const id of picked) {
      const c = contacts.find((x) => x.id === id);
      if (c?.name) out.push({ name: c.name, contactId: c.id });
    }
    for (const raw of attendeesText.split(/[\n,]/)) {
      const name = raw.trim();
      if (name) out.push({ name, contactId: null });
    }
    return out;
  }

  async function onRecord(e: FormEvent) {
    e.preventDefault();
    if (!date || !title.trim()) return;
    if (!body.trim() && !file) {
      setError("Add the minutes body or attach a file — a minute needs at least one.");
      return;
    }
    await run(async () => {
      const input: Parameters<typeof recordMinute>[1] = {
        date,
        title: title.trim(),
        attendees: collectAttendees(),
        body: body.trim(),
      };
      if (file) {
        input.dataUrl = await fileToDataUrl(file);
        input.fileName = file.name;
        input.mimeType = file.type || undefined;
      }
      await recordMinute(jobId, input);
      setDate(today);
      setTitle("");
      setAttendeesText("");
      setBody("");
      setFile(null);
      setPicked(new Set());
    });
  }

  // Newest-first by meeting date, then created order (createdAt) as a tiebreak.
  const sorted = [...minutes].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Meeting minutes</h1>
        <p className="text-sm text-slate-500">
          The record of every meeting on this job — who was there and what was decided. Append-only:
          a correction is a stamped amendment beneath the original, which is never changed.
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

      {/* Record */}
      <form onSubmit={onRecord} className="space-y-3 rounded-lg border border-slate-200 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Site coordination meeting"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="space-y-2">
          <span className="block text-sm font-medium text-slate-700">Attendees</span>
          {contacts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {contacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => togglePicked(c.id)}
                  className={
                    "rounded-full px-3 py-1 text-xs font-medium " +
                    (picked.has(c.id) ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700")
                  }
                >
                  {c.name || "(unnamed)"}
                </button>
              ))}
            </div>
          )}
          <input
            value={attendeesText}
            onChange={(e) => setAttendeesText(e.target.value)}
            placeholder="Other attendees — comma-separated"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Minutes (optional if you attach a file)</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            maxLength={10000}
            placeholder="What was discussed, decided and actioned…"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Attach PDF / image (optional)</span>
            <input
              type="file"
              accept="application/pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !date || !title.trim() || (!body.trim() && !file)}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Record minutes
          </button>
        </div>
      </form>

      {/* List */}
      {sorted.length === 0 ? (
        <p className="text-sm text-slate-500">No minutes recorded on this job yet.</p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((m) => (
            <li key={m.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium text-slate-900">{m.title}</div>
                <span className="font-mono text-xs text-slate-500">{m.date}</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {m.attendees.length > 0
                  ? `Attendees: ${m.attendees.map((a) => a.name).join(", ")}`
                  : "No attendees recorded"}
              </div>

              {m.body ? (
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{m.body}</p>
              ) : (
                <p className="mt-2 text-sm italic text-slate-400">No written minutes — see the attachment.</p>
              )}

              {m.attachment ? (
                <a
                  href={m.attachment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-sm font-medium text-blue-700 underline"
                >
                  {m.attachment.fileName || "Open attachment"}
                </a>
              ) : null}

              {/* Amendments — stamped, beneath the unchanged original. */}
              {m.amendments.length > 0 && (
                <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Amendments
                  </div>
                  {m.amendments.map((am, i) => (
                    <div key={i} className="rounded bg-amber-50 p-2 text-sm text-amber-900">
                      <div className="text-xs text-amber-700">
                        {am.by} · {new Date(am.at).toLocaleString()}
                      </div>
                      <div className="whitespace-pre-wrap">{am.note}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add amendment */}
              <div className="mt-3">
                {amendId === m.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={amendNote}
                      onChange={(e) => setAmendNote(e.target.value)}
                      rows={2}
                      placeholder="The correction or clarification — the original stays unchanged…"
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy || !amendNote.trim()}
                        onClick={() =>
                          run(async () => {
                            await amendMinute(jobId, m.id, amendNote.trim());
                            setAmendId(null);
                            setAmendNote("");
                          })
                        }
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Save amendment
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAmendId(null);
                          setAmendNote("");
                        }}
                        className="rounded-md px-3 py-1.5 text-sm text-slate-600"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setAmendId(m.id);
                      setAmendNote("");
                    }}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800"
                  >
                    Add amendment
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
