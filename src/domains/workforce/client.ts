import { httpDelete, httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  CredentialListResponseSchema,
  CredentialMutationResponseSchema,
  CredentialRemoveResponseSchema,
} from "./schema";
import type {
  AddCredentialPayload,
  CredentialListResponse,
  UpdateCredentialPayload,
} from "./types";

/** Client verbs for /api/licences (#331). Errors surface as HttpResult —
 *  callers render the message, nothing throws. */

type Mutation = HttpResult<{ credential: unknown } & Record<string, unknown>>;

export async function myLicences(): Promise<HttpResult<CredentialListResponse>> {
  return httpGet<CredentialListResponse>("/api/licences?mine=1", {
    schema: CredentialListResponseSchema,
  });
}

export async function licencesFor(
  userId: string
): Promise<HttpResult<CredentialListResponse>> {
  return httpGet<CredentialListResponse>(
    `/api/licences?userId=${encodeURIComponent(userId)}`,
    { schema: CredentialListResponseSchema }
  );
}

export async function allLicences(): Promise<HttpResult<CredentialListResponse>> {
  return httpGet<CredentialListResponse>("/api/licences", {
    schema: CredentialListResponseSchema,
  });
}

export async function addLicence(payload: AddCredentialPayload): Promise<Mutation> {
  return httpPost("/api/licences", payload, {
    schema: CredentialMutationResponseSchema,
  });
}

export async function updateLicence(payload: UpdateCredentialPayload): Promise<Mutation> {
  return httpPut("/api/licences", payload, {
    schema: CredentialMutationResponseSchema,
  });
}

export async function removeLicence(
  id: string
): Promise<HttpResult<{ ok: boolean; removedId: string }>> {
  return httpDelete(`/api/licences?id=${encodeURIComponent(id)}`, {
    schema: CredentialRemoveResponseSchema,
  });
}
