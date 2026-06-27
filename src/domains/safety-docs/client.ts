import { SafetyDocsResponseSchema, type SafetyDocsResponse, type SafetyDocType } from "./schema";

/**
 * Browser client for the safety-docs surface (#219). Admin uploads; assigned
 * crew (and managers) read + acknowledge. The acknowledgement carries NO
 * identity — the server attributes it from the session.
 */

export async function fetchSafetyDocs(jobId: string): Promise<SafetyDocsResponse> {
  const res = await fetch(`/api/safety-docs?jobId=${encodeURIComponent(jobId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await errText(res, "Couldn't load safety documents"));
  return SafetyDocsResponseSchema.parse(await res.json());
}

export async function acknowledgeSafetyDoc(jobId: string, docId: string): Promise<void> {
  const res = await fetch(
    `/api/safety-docs?jobId=${encodeURIComponent(jobId)}&action=acknowledge`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId }),
    }
  );
  if (!res.ok) throw new Error(await errText(res, "Couldn't record your acknowledgement"));
}

export async function uploadSafetyDoc(
  jobId: string,
  input: { file: File; type: SafetyDocType; title: string; supersedesId?: string }
): Promise<void> {
  const dataUrl = await fileToDataUrl(input.file);
  const res = await fetch(`/api/safety-docs?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: input.type,
      title: input.title,
      supersedesId: input.supersedesId,
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
