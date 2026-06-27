import {
  CertificatesResponseSchema,
  type CertificatesResponse,
  type CertificateType,
} from "./schema";

/**
 * Browser client for the certificates register (#231). Admin uploads; admin +
 * assigned crew read. Read-only for the field — no approval workflow.
 */

export async function fetchCertificates(jobId: string): Promise<CertificatesResponse> {
  const res = await fetch(`/api/certificates?jobId=${encodeURIComponent(jobId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await errText(res, "Couldn't load certificates"));
  return CertificatesResponseSchema.parse(await res.json());
}

export async function uploadCertificate(
  jobId: string,
  input: {
    file: File;
    type: CertificateType;
    title: string;
    referenceNo?: string;
    issuedAt?: string;
  }
): Promise<void> {
  const dataUrl = await fileToDataUrl(input.file);
  const res = await fetch(`/api/certificates?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: input.type,
      title: input.title,
      referenceNo: input.referenceNo ?? "",
      issuedAt: input.issuedAt ?? "",
      fileName: input.file.name,
      mimeType: input.file.type,
      dataUrl,
    }),
  });
  if (!res.ok) throw new Error(await errText(res, "Upload failed"));
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

async function errText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || `${fallback} (${res.status})`;
}
