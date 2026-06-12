import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ItpTemplateLibrary } from "./ItpTemplateLibrary";
import type { ITPTemplateSummary } from "@/domains/itp/types";

/**
 * Static guards for the template library (#284). Write paths are pinned by
 * the templates/attach API harnesses (incl. snapshot preservation).
 */

const tpl = (id: string, name: string, extra: Partial<ITPTemplateSummary> = {}): ITPTemplateSummary =>
  ({ id, name, points: [{ id: "p1" }, { id: "p2" }], ...extra }) as ITPTemplateSummary;

describe("ItpTemplateLibrary", () => {
  it("lists live templates with point counts and the snapshot promise", () => {
    const html = renderToString(
      createElement(ItpTemplateLibrary, {
        initialTemplates: [tpl("t1", "MSB energisation", { category: "Electrical" })],
        fetchError: null,
      }),
    );
    expect(html).toContain("MSB energisation");
    expect(html).toContain("Electrical · ");
    expect(html).toMatch(/2<!-- --> point/);
    expect(html).toContain("never changes checks already attached");
    expect(html).toContain("template-create-open");
  });

  it("archived templates sit in their own quiet list", () => {
    const html = renderToString(
      createElement(ItpTemplateLibrary, {
        initialTemplates: [tpl("t1", "Live one"), tpl("t2", "Old one", { archived: true })],
        fetchError: null,
      }),
    );
    expect(html).toContain("Archived");
    expect(html).toContain("Old one");
  });

  it("honest empty state when the library has nothing yet", () => {
    const html = renderToString(
      createElement(ItpTemplateLibrary, { initialTemplates: [], fetchError: null }),
    );
    expect(html).toContain("No templates yet");
  });
});
