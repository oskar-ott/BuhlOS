import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobContactsCard } from "./PhilJobContactsCard";
import type { JobContact } from "@/domains/contacts/schema";

/** #189 — tap-to-call contacts; legacy email-list rows stay invisible. */

const contacts: JobContact[] = [
  { id: "c1", name: "Dave the Builder", role: "Site supervisor", phone: "0412 345 678", category: "project" },
  { id: "c2", name: "MM Electrical", description: "Switchboards", phone: "+61299998888", category: "supplier" },
  { id: "c3", name: "Legacy Row", email: "old@list.com" }, // uncategorised — snag-email picker
];

describe("PhilJobContactsCard", () => {
  it("renders categorised contacts with cleaned tel:/sms: links", () => {
    const html = renderToString(createElement(PhilJobContactsCard, { contacts }));
    expect(html).toContain("Who to call");
    expect(html).toContain("Dave the Builder");
    expect(html).toContain("Site supervisor");
    expect(html).toContain('href="tel:0412345678"');
    expect(html).toContain('href="sms:0412345678"');
    expect(html).toContain('href="tel:+61299998888"');
    expect(html).toContain("Suppliers");
    // #424: Call/Text are 48px glove targets and the explainer sentence is
    // gone (the card only ever renders populated — the buttons speak for it).
    expect(html).toContain("min-h-[48px]");
    expect(html).not.toContain("key people");
  });

  it("legacy uncategorised rows never render", () => {
    const html = renderToString(createElement(PhilJobContactsCard, { contacts }));
    expect(html).not.toContain("Legacy Row");
    expect(html).not.toContain("old@list.com");
  });

  it("renders NOTHING when only legacy rows exist", () => {
    const html = renderToString(
      createElement(PhilJobContactsCard, { contacts: [contacts[2]!] }),
    );
    expect(html).toBe("");
  });
});
