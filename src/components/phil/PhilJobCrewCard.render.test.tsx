import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobCrewBody, type CrewLoadState } from "./PhilJobCrewCard";

/**
 * #426 — the pure presentation of the "On site today" crew card. Drives the
 * prop-only body through each state (the card's fetch wrapper is inert under
 * SSR). Honesty: "Just you" when no others, a quiet message on error, self
 * excluded from the list — never a fabricated name/count (P7).
 */
const render = (state: CrewLoadState, viewerId: string | null) =>
  renderToString(createElement(PhilJobCrewBody, { state, viewerId }));

describe("PhilJobCrewBody (#426)", () => {
  it("lists the other crew with their hours, excluding the viewer", () => {
    const html = render(
      {
        status: "ready",
        members: [
          { id: "u_me", username: "Me", hours: 8 },
          { id: "u_sam", username: "Sam", hours: 6.5 },
        ],
      },
      "u_me",
    );
    expect(html).toContain("Sam");
    expect(html).toContain("6.5h");
    expect(html).not.toContain("Me"); // viewer excluded from "others"
  });

  it("says 'Just you so far today' when no one else has logged", () => {
    const html = render(
      { status: "ready", members: [{ id: "u_me", username: "Me", hours: 8 }] },
      "u_me",
    );
    expect(html).toContain("Just you so far today");
  });

  it("shows a quiet honest message on error — never an alarm or fake data", () => {
    const html = render({ status: "error" }, "u_me");
    expect(html).toContain("Couldn");
    expect(html).not.toContain("0h");
  });

  it("renders a loading skeleton", () => {
    const html = render({ status: "loading" }, "u_me");
    expect(html).toContain("Loading who");
  });
});
