import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * api/_lib/xero/token-store.js (#247) — the encrypted connection row store.
 * Exercised against a scripted in-memory postgres.js-shaped fake (tagged
 * template + .begin), so no socket is ever opened: replace-on-reconnect
 * (delete + insert, never revive), refresh_version CAS (winner updates,
 * loser gets null), encryption-at-rest (envelopes only in the row).
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = requireFromHere("../../../api/_lib/xero/token-store.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const secretBox = requireFromHere("../../../api/_lib/secret-box.js");

const KEY = Buffer.alloc(32, 7).toString("base64");
const env = { XERO_TOKEN_ENC_KEY: KEY };

type Row = Record<string, unknown> & { id: string; refresh_version: number; status: string };

function makeFakeSql(state: { row: Row | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join("$v");
    if (text.includes("from public.tenants")) return [{ id: "tenant-1" }];
    if (text.includes("select * from public.integration_connections")) {
      return state.row ? [{ ...state.row }] : [];
    }
    if (text.includes("delete from public.integration_connections")) {
      state.row = null;
      return [];
    }
    if (text.includes("insert into public.integration_connections")) {
      const [tenantId, provider, accessEnc, refreshEnc, expiresAt, scope, byId, byName] = vals;
      state.row = {
        id: "conn-1",
        tenant_id: tenantId as string,
        provider: provider as string,
        status: "pending_selection",
        access_token_enc: accessEnc as string,
        refresh_token_enc: refreshEnc as string,
        access_token_expires_at: expiresAt as string,
        granted_scopes: scope as string,
        connected_by_legacy_id: byId as string,
        connected_by_name: byName as string,
        external_tenant_id: null,
        external_tenant_name: null,
        refresh_version: 1,
        last_error_category: null,
      };
      return [{ ...state.row }];
    }
    if (text.includes("set external_tenant_id")) {
      const [externalTenantId, externalTenantName, id] = vals;
      if (!state.row || state.row.id !== id || state.row.status !== "pending_selection") return [];
      Object.assign(state.row, {
        external_tenant_id: externalTenantId,
        external_tenant_name: externalTenantName,
        status: "connected",
      });
      return [{ ...state.row }];
    }
    if (text.includes("refresh_version = refresh_version + 1")) {
      const [accessEnc, refreshEnc, expiresAt, scope, id, expectedVersion] = vals;
      if (!state.row || state.row.id !== id || state.row.refresh_version !== expectedVersion) return [];
      Object.assign(state.row, {
        access_token_enc: accessEnc,
        refresh_token_enc: refreshEnc,
        access_token_expires_at: expiresAt,
        granted_scopes: scope,
        refresh_version: (state.row.refresh_version as number) + 1,
        status: state.row.status === "degraded" || state.row.status === "refresh_failed" ? "connected" : state.row.status,
        last_error_category: null,
      });
      return [{ ...state.row }];
    }
    if (text.includes("last_error_category = $v")) {
      const [errorCategory, status, id] = vals;
      if (!state.row || state.row.id !== id) return [];
      Object.assign(state.row, {
        last_error_category: errorCategory,
        status: status ?? state.row.status,
      });
      return [{ ...state.row }];
    }
    if (text.includes("set last_success_at")) {
      return [];
    }
    throw new Error(`fake sql: unmatched query: ${text.slice(0, 80)}`);
  };
  sql.begin = async (cb: (tx: unknown) => Promise<unknown>) => cb(sql);
  return sql;
}

const TOKENS = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: new Date(Date.now() + 1800_000).toISOString(),
  scope: "openid profile email offline_access",
};

describe("token-store", () => {
  let state: { row: Row | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sql: any;

  beforeEach(() => {
    state = { row: null };
    sql = makeFakeSql(state);
  });

  it("replaceConnection stores ENVELOPES, never plaintext, status pending_selection", async () => {
    const row = await store.replaceConnection({
      tokens: TOKENS,
      actor: { id: "u_boss", name: "Boss" },
      sql,
      env,
    });
    expect(row.status).toBe("pending_selection");
    expect(String(row.access_token_enc).startsWith("v1.")).toBe(true);
    expect(String(row.refresh_token_enc).startsWith("v1.")).toBe(true);
    expect(JSON.stringify(row)).not.toContain("at-1");
    expect(JSON.stringify(row)).not.toContain("rt-1");
    // and they decrypt back with the right AADs
    expect(store.decryptTokens(row, env)).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
  });

  it("reconnect replaces the row — stale ciphertext is never revived", async () => {
    await store.replaceConnection({ tokens: TOKENS, actor: { id: "u1" }, sql, env });
    const first = state.row?.access_token_enc;
    await store.replaceConnection({
      tokens: { ...TOKENS, accessToken: "at-2", refreshToken: "rt-2" },
      actor: { id: "u1" },
      sql,
      env,
    });
    expect(state.row?.access_token_enc).not.toBe(first);
    expect(store.decryptTokens(state.row, env).accessToken).toBe("at-2");
  });

  it("selectOrganisation flips pending_selection → connected exactly once", async () => {
    await store.replaceConnection({ tokens: TOKENS, actor: { id: "u1" }, sql, env });
    const selected = await store.selectOrganisation({
      id: "conn-1",
      externalTenantId: "org-1",
      externalTenantName: "Buhl Electrical",
      sql,
    });
    expect(selected.status).toBe("connected");
    expect(selected.external_tenant_name).toBe("Buhl Electrical");
    // a second selection attempt finds nothing pending
    const again = await store.selectOrganisation({
      id: "conn-1",
      externalTenantId: "org-2",
      externalTenantName: "Other",
      sql,
    });
    expect(again).toBeNull();
  });

  it("rotateTokens CAS: matching version wins and bumps; stale version returns null", async () => {
    await store.replaceConnection({ tokens: TOKENS, actor: { id: "u1" }, sql, env });
    const next = { ...TOKENS, accessToken: "at-2", refreshToken: "rt-2" };
    const winner = await store.rotateTokens({ id: "conn-1", expectedVersion: 1, tokens: next, sql, env });
    expect(winner).not.toBeNull();
    expect(winner.refresh_version).toBe(2);
    // the loser raced with the OLD version — CAS refuses, returns null
    const loser = await store.rotateTokens({ id: "conn-1", expectedVersion: 1, tokens: TOKENS, sql, env });
    expect(loser).toBeNull();
    // the winner's tokens survived
    expect(store.decryptTokens(state.row, env).refreshToken).toBe("rt-2");
  });

  it("markFailure records the category and can move status terminally", async () => {
    await store.replaceConnection({ tokens: TOKENS, actor: { id: "u1" }, sql, env });
    await store.selectOrganisation({ id: "conn-1", externalTenantId: "o", externalTenantName: "O", sql });
    const degraded = await store.markFailure({ id: "conn-1", status: "degraded", errorCategory: "timeout", sql });
    expect(degraded.status).toBe("degraded");
    const terminal = await store.markFailure({
      id: "conn-1",
      status: "reconnect_required",
      errorCategory: "reconnect_required",
      sql,
    });
    expect(terminal.status).toBe("reconnect_required");
  });

  it("envelope AAD separation holds at the store level", async () => {
    await store.replaceConnection({ tokens: TOKENS, actor: { id: "u1" }, sql, env });
    const row = state.row!;
    // swapping the columns must fail decryption (access AAD ≠ refresh AAD)
    const swapped = {
      ...row,
      access_token_enc: row.refresh_token_enc,
      refresh_token_enc: row.access_token_enc,
    };
    expect(() => store.decryptTokens(swapped, env)).toThrowError(
      expect.objectContaining({ code: "decrypt_failed" })
    );
    void secretBox; // (imported for parity with other suites)
  });
});
