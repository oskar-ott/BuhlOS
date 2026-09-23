"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { attachInvoiceDocument, uploadInvoice } from "@/domains/invoices/client";
import type { InvoiceDetail } from "@/domains/invoices/schema";

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Manual upload — the way the workflow is tested before the inbound address is
 * wired, and the office's path for the odd invoice that never came by email.
 * One PDF or photo (JPEG/PNG/WebP) at a time — the server sniffs the bytes;
 * the extension is not trusted. On success the office lands straight on the
 * review screen. With `attachTo`, the file is attached to an existing record
 * that arrived without a usable document and the detail is handed back.
 */
export function InvoiceUploadButton({
  maxBytes = DEFAULT_MAX_BYTES,
  onUploaded,
  attachTo,
  onAttached,
}: {
  maxBytes?: number;
  /** Optional hook for the inbox to refresh; navigation to review still happens. */
  onUploaded?: () => void;
  /** Attach to this invoice record instead of creating a new one. */
  attachTo?: string;
  onAttached?: (detail: InvoiceDetail) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > maxBytes) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = attachTo ? await attachInvoiceDocument(attachTo, { filename: file.name, dataUrl }) : await uploadInvoice({ filename: file.name, dataUrl });
      if (!res.ok) {
        const code = (res.error.body as { error?: string } | null)?.error;
        setError(
          code === "not_a_pdf" || code === "not_a_pdf_or_image"
            ? "That file is not a PDF or a photo (JPEG, PNG, WebP)."
            : code === "file_too_large"
              ? "That file is too large."
              : code === "already_has_document"
                ? "This record already has a document."
                : `Upload failed (${res.error.status || "network"}). Try again.`
        );
        return;
      }
      if (attachTo) {
        onAttached?.(res.data);
        return;
      }
      onUploaded?.();
      // Full navigation (not the app router): the review page is a server
      // component that re-checks the gate, and this keeps the button SSR-safe.
      window.location.assign(`/invoices/${encodeURIComponent(res.data.invoice.id)}`);
    } catch {
      setError("Could not read that file.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        className="hidden"
        data-testid="invoice-upload-input"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <Button
        type="button"
        variant={attachTo ? "secondary" : "primary"}
        size="sm"
        disabled={busy}
        data-testid="invoice-upload-button"
        onClick={() => inputRef.current?.click()}
      >
        <Upload aria-hidden="true" className="mr-1.5 h-4 w-4" />
        {busy ? "Reading…" : attachTo ? "Attach the PDF or photo" : "Upload a PDF or photo"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-state-danger-subtle-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
