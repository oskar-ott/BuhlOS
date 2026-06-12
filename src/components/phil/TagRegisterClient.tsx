"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { PhilNotice } from "./ui/PhilNotice";
import {
  createTag,
  deleteTag,
  listTags,
  runTagOcr,
  updateTag,
  uploadTagPhoto,
} from "@/domains/tags/client";
import {
  sortTagsForRegister,
  tagDisplayName,
  tagExpiryState,
} from "@/domains/tags/expiry";
import type { TagDraft, TagItem } from "@/domains/tags/schema";

/**
 * /phil/jobs/[jobId]/tags — the per-job Test & Tag register (#388).
 *
 * Rebuilds the capture surface the legacy cutover deleted, over the
 * untouched api/tags.js: list with expired/expiring flags, photo → OCR →
 * EDITABLE confirm (AI assists, never silently decides — low-confidence
 * fields are visibly flagged for human verify), manual entry, edit, delete.
 * Server-side `canWrite` is the write gate; this page is only reachable by
 * workers assigned to the job (and the API re-checks).
 */

interface Props {
  jobId: string;
  initialTags: ReadonlyArray<TagItem>;
  fetchError: string | null;
}

/** OCR confidence below this is flagged on the confirm form. */
const LOW_CONFIDENCE = 0.7;

const OCR_FIELDS = [
  "tagNumber",
  "applianceType",
  "testedBy",
  "testDate",
  "expiryDate",
  "result",
] as const;

type DraftState = TagDraft & { id?: string };

type Sheet =
  | { kind: "add-source" }
  | {
      kind: "form";
      mode: "create" | "edit";
      draft: DraftState;
      confidence: Record<string, number>;
      ocrFailed: boolean;
    }
  | { kind: "delete"; tag: TagItem }
  | null;

function emptyDraft(): DraftState {
  return {
    applianceType: "",
    tagNumber: "",
    owner: "",
    testedBy: "",
    testDate: "",
    expiryDate: "",
    retestInterval: "",
    result: "",
    notes: "",
    photoUrl: "",
  };
}

function draftFrom(tag: TagItem): DraftState {
  return {
    id: tag.id,
    applianceType: tag.applianceType ?? tag.name ?? "",
    tagNumber: tag.tagNumber ?? "",
    owner: tag.owner ?? "",
    testedBy: tag.testedBy ?? "",
    testDate: tag.testDate ?? "",
    expiryDate: tag.expiryDate ?? "",
    retestInterval: tag.retestInterval ?? "",
    result: tag.result ?? "",
    notes: tag.notes ?? "",
    photoUrl: tag.photoUrl ?? "",
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the photo"));
    reader.readAsDataURL(file);
  });
}

export function TagRegisterClient({ jobId, initialTags, fetchError }: Props) {
  const [tags, setTags] = useState<ReadonlyArray<TagItem>>(initialTags);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(fetchError);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const sorted = useMemo(() => sortTagsForRegister(tags), [tags]);

  async function refresh() {
    const result = await listTags(jobId);
    if (result.ok) setTags(result.data.tags);
  }

  async function startPhotoFlow(file: File) {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      setBusy("Uploading photo…");
      const dataUrl = await readFileAsDataUrl(file);
      const uploaded = await uploadTagPhoto(jobId, dataUrl);
      if (!uploaded.ok) throw new Error(uploaded.error.message);

      setBusy("Reading the tag…");
      const ocr = await runTagOcr(jobId, uploaded.data.url);
      if (!ocr.ok) throw new Error(ocr.error.message);

      const ocrFailed = Boolean(ocr.data.error);
      setSheet({
        kind: "form",
        mode: "create",
        draft: {
          ...emptyDraft(),
          ...ocr.data.fields,
          photoUrl: uploaded.data.url,
          ocrConfidence: ocr.data.confidence,
        },
        confidence: ocr.data.confidence ?? {},
        ocrFailed,
      });
    } catch (err) {
      setSheet(null);
      setErrorMessage(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setBusy(null);
    }
  }

  function save(draft: DraftState) {
    setErrorMessage(null);
    setSuccessMessage(null);
    startTransition(async () => {
      const { id, ...fields } = draft;
      const result = id ? await updateTag(jobId, id, fields) : await createTag(jobId, fields);
      if (!result.ok) {
        setErrorMessage(result.error.message);
        return;
      }
      setSheet(null);
      setSuccessMessage(id ? "Tag updated" : "Tag added to the register");
      await refresh();
    });
  }

  function removeTag(tag: TagItem) {
    setErrorMessage(null);
    setSuccessMessage(null);
    startTransition(async () => {
      const result = await deleteTag(jobId, tag.id);
      if (!result.ok) {
        setErrorMessage(result.error.message);
        return;
      }
      setSheet(null);
      setSuccessMessage(`Removed ${tagDisplayName(tag)}`);
      await refresh();
    });
  }

  return (
    <div className="space-y-3">
      {errorMessage ? (
        <PhilNotice tone="danger" role="alert">
          {errorMessage}
        </PhilNotice>
      ) : null}
      {successMessage ? (
        <PhilNotice tone="success" role="status">
          {successMessage}
        </PhilNotice>
      ) : null}

      <Button
        size="lg"
        className="w-full"
        onClick={() => setSheet({ kind: "add-source" })}
        disabled={isPending || busy !== null}
        data-testid="tag-register-add"
      >
        Add a tag
      </Button>

      {busy ? (
        <PhilNotice tone="info" role="status">
          {busy}
        </PhilNotice>
      ) : null}

      {sorted.length === 0 && !errorMessage ? (
        <Card>
          <p className="text-sm text-text-muted">
            No test &amp; tag entries on this job yet. Photograph a tag sticker and the fields
            fill themselves in — you confirm them before anything is saved.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {sorted.map((tag) => (
            <TagRow key={tag.id} tag={tag} onEdit={() => setSheet({ kind: "form", mode: "edit", draft: draftFrom(tag), confidence: {}, ocrFailed: false })} />
          ))}
        </ul>
      )}

      {sheet?.kind === "add-source" ? (
        <SheetFrame title="Add a tag" onClose={() => setSheet(null)}>
          <p className="text-sm text-text-muted">
            Photograph the test tag sticker — the fields fill themselves in for you to check.
          </p>
          <label className="block">
            <span className="sr-only">Take a photo of the tag</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              data-testid="tag-photo-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void startPhotoFlow(file);
              }}
            />
            <span className="flex h-12 w-full cursor-pointer items-center justify-center rounded-card bg-brand-navy text-sm font-medium text-white">
              Take a photo
            </span>
          </label>
          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            onClick={() =>
              setSheet({ kind: "form", mode: "create", draft: emptyDraft(), confidence: {}, ocrFailed: false })
            }
          >
            Type it in manually
          </Button>
        </SheetFrame>
      ) : null}

      {sheet?.kind === "form" ? (
        <TagForm
          sheet={sheet}
          isPending={isPending}
          onClose={() => setSheet(null)}
          onSave={save}
          onDelete={
            sheet.mode === "edit" && sheet.draft.id
              ? () => {
                  const tag = tags.find((t) => t.id === sheet.draft.id);
                  if (tag) setSheet({ kind: "delete", tag });
                }
              : undefined
          }
        />
      ) : null}

      {sheet?.kind === "delete" ? (
        <SheetFrame title="Remove this entry?" onClose={() => setSheet(null)}>
          <p className="text-sm text-text-muted">
            Removes {tagDisplayName(sheet.tag)} from this job&rsquo;s register. There&rsquo;s no
            undo.
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={() => setSheet(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button size="lg" className="flex-1" onClick={() => removeTag(sheet.tag)} disabled={isPending}>
              {isPending ? "Removing…" : "Remove"}
            </Button>
          </div>
        </SheetFrame>
      ) : null}
    </div>
  );
}

function TagRow({ tag, onEdit }: { tag: TagItem; onEdit: () => void }) {
  const expiry = tagExpiryState(tag.expiryDate);
  return (
    <li>
      <Card className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-base text-text">{tagDisplayName(tag)}</h3>
            <p className="text-xs text-text-muted">
              {tag.tagNumber ? `Tag ${tag.tagNumber}` : "No tag number"}
              {tag.owner ? ` · ${tag.owner}` : ""}
            </p>
          </div>
          {expiry.status === "expired" ? (
            <Pill tone="danger">{`${-(expiry.daysToExpiry ?? 0)}d overdue`}</Pill>
          ) : expiry.status === "expiring" ? (
            <Pill tone="warning">
              {expiry.daysToExpiry === 0 ? "Due today" : `Due in ${expiry.daysToExpiry}d`}
            </Pill>
          ) : expiry.status === "ok" ? (
            <Pill tone="success">In date</Pill>
          ) : (
            <Pill tone="neutral">No expiry</Pill>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-muted">
          <dt>Expiry</dt>
          <dd className="text-text">{tag.expiryDate || "—"}</dd>
          <dt>Result</dt>
          <dd className={tag.result === "fail" ? "font-medium text-state-danger" : "text-text"}>
            {tag.result === "pass" ? "Pass" : tag.result === "fail" ? "FAIL" : "—"}
          </dd>
        </dl>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          {tag.photoUrl ? (
            <a
              href={tag.photoUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-text-muted underline underline-offset-2"
            >
              View photo
            </a>
          ) : null}
        </div>
      </Card>
    </li>
  );
}

const FIELD_LABELS: Record<(typeof OCR_FIELDS)[number], string> = {
  tagNumber: "Tag number",
  applianceType: "What is it?",
  testedBy: "Tested by",
  testDate: "Test date",
  expiryDate: "Expiry / retest date",
  result: "Result",
};

function TagForm({
  sheet,
  isPending,
  onClose,
  onSave,
  onDelete,
}: {
  sheet: Extract<NonNullable<Sheet>, { kind: "form" }>;
  isPending: boolean;
  onClose: () => void;
  onSave: (draft: DraftState) => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState<DraftState>(sheet.draft);
  const set = (k: keyof TagDraft, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const lowConfidence = (field: string) =>
    sheet.mode === "create" &&
    !sheet.ocrFailed &&
    sheet.draft.photoUrl !== "" &&
    (sheet.confidence[field] ?? 0) < LOW_CONFIDENCE;

  const inputClass =
    "h-11 w-full rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none";

  return (
    <SheetFrame
      title={sheet.mode === "edit" ? "Edit tag" : "Check the tag details"}
      onClose={onClose}
    >
      {sheet.ocrFailed ? (
        <PhilNotice tone="warning" role="status">
          Couldn&rsquo;t read the sticker — fill the fields in yourself. The photo stays attached.
        </PhilNotice>
      ) : sheet.mode === "create" && sheet.draft.photoUrl ? (
        <p className="text-xs text-text-muted">
          Read from your photo — check each field before saving. Anything marked
          &ldquo;check this&rdquo; was hard to read.
        </p>
      ) : null}

      {draft.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={draft.photoUrl}
          alt="Tag sticker photo"
          className="max-h-40 w-full rounded-card object-contain bg-surface-subtle"
        />
      ) : null}

      <div className="space-y-3">
        {OCR_FIELDS.map((field) =>
          field === "result" ? (
            <label key={field} className="block text-sm">
              <span className="text-text-muted">{FIELD_LABELS[field]}</span>
              {lowConfidence(field) ? <LowConfidenceHint /> : null}
              <select
                value={draft.result}
                onChange={(e) => set("result", e.target.value)}
                className={inputClass}
                data-testid="tag-field-result"
              >
                <option value="">—</option>
                <option value="pass">Pass</option>
                <option value="fail">Fail</option>
              </select>
            </label>
          ) : (
            <label key={field} className="block text-sm">
              <span className="text-text-muted">{FIELD_LABELS[field]}</span>
              {lowConfidence(field) ? <LowConfidenceHint /> : null}
              <input
                type="text"
                value={draft[field]}
                onChange={(e) => set(field, e.target.value)}
                placeholder={field.endsWith("Date") ? "dd/mm/yyyy" : undefined}
                className={inputClass}
                data-testid={`tag-field-${field}`}
              />
            </label>
          ),
        )}

        <label className="block text-sm">
          <span className="text-text-muted">Owner (whose gear is it?)</span>
          <input
            type="text"
            value={draft.owner}
            onChange={(e) => set("owner", e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="block text-sm">
          <span className="text-text-muted">Retest interval</span>
          <select
            value={draft.retestInterval}
            onChange={(e) => set("retestInterval", e.target.value)}
            className={inputClass}
          >
            <option value="">—</option>
            <option value="1mo">1 month</option>
            <option value="3mo">3 months</option>
            <option value="6mo">6 months</option>
            <option value="12mo">12 months</option>
          </select>
        </label>

        <label className="block text-sm">
          <span className="text-text-muted">Notes</span>
          <textarea
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={2}
            className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
          />
        </label>
      </div>

      <div className="flex gap-2">
        <Button variant="secondary" size="lg" className="flex-1" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button
          size="lg"
          className="flex-1"
          onClick={() => onSave(draft)}
          disabled={isPending || !draft.applianceType.trim()}
          data-testid="tag-form-save"
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="w-full text-center text-xs text-state-danger underline underline-offset-2"
          disabled={isPending}
        >
          Remove this entry
        </button>
      ) : null}
    </SheetFrame>
  );
}

function LowConfidenceHint() {
  return (
    <span className="ml-2 rounded-card border border-state-warning px-1.5 py-0.5 text-[11px] font-medium text-state-warning">
      check this
    </span>
  );
}

function SheetFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-end justify-center bg-accent-ink/40 p-3 sm:items-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-card bg-surface-raised p-5 shadow-raised"
      >
        <h2 className="font-display text-lg text-text">{title}</h2>
        {children}
      </div>
    </div>
  );
}
