import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Legibility floor (#423) — a grep-based guard, mirroring check:role-literals.
 *
 * Phil is a field PWA read in midday sun through safety glasses. The master
 * audit (docs/phil-ux-master-audit.md F1) found 15 font sizes on My Day —
 * eleven ≤10px, one literally 7px. This test pins the floor so the bug can't
 * creep back:
 *   - no font-size below 12px in myDay.module.css;
 *   - no `text-[<12px]` Tailwind bracket sizes anywhere in src/components/phil.
 *
 * Caption-tier is the 12px floor; the glanceable per-day value (hours) and the
 * headline status ("Today not logged") sit at 14px — checked by the CSS scan
 * implicitly (nothing below 12 survives).
 */

const PHIL_DIR = join(__dirname);
const MIN_PX = 12;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("Phil legibility floor (#423)", () => {
  const files = walk(PHIL_DIR);

  it("myDay.module.css has no font-size below 12px (the 7px bug can't return)", () => {
    const css = readFileSync(join(PHIL_DIR, "myDay.module.css"), "utf8");
    const offenders: string[] = [];
    for (const m of css.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      if (parseFloat(m[1]!) < MIN_PX) offenders.push(`${m[1]}px`);
    }
    expect(offenders, `sub-${MIN_PX}px font sizes: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no Tailwind text-[<12px] bracket sizes in any Phil component", () => {
    const offenders: Array<{ file: string; size: string }> = [];
    for (const file of files) {
      if (file.endsWith(".css")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/text-\[([0-9.]+)px\]/g)) {
        if (parseFloat(m[1]!) < MIN_PX) {
          offenders.push({ file: file.replace(PHIL_DIR, "phil"), size: `${m[1]}px` });
        }
      }
    }
    expect(
      offenders,
      `sub-${MIN_PX}px bracket sizes:\n${offenders.map((o) => `  ${o.file}: text-[${o.size}]`).join("\n")}`
    ).toEqual([]);
  });

  it("no opacity-based state styling on the week-strip off/upcoming cells", () => {
    const css = readFileSync(join(PHIL_DIR, "myDay.module.css"), "utf8");
    // The .off/.upcoming cells must distinguish by border/colour, not opacity
    // (which dims the whole cell illegibly in glare).
    const offBlock = css.slice(css.indexOf(".off .box,"));
    const firstRule = offBlock.slice(0, offBlock.indexOf("}"));
    expect(firstRule).not.toContain("opacity");
  });

  it("one design dialect — no JetBrains Mono face left in My Day (#423)", () => {
    const css = readFileSync(join(PHIL_DIR, "myDay.module.css"), "utf8");
    expect(css.toLowerCase()).not.toContain("jetbrains");
    // ...and the page no longer imports/loads the mono font.
    const page = readFileSync(
      join(PHIL_DIR, "..", "..", "app", "phil", "my-day", "page.tsx"),
      "utf8"
    );
    expect(page).not.toContain("JetBrains_Mono");
    expect(page).not.toContain("font-jetbrains");
  });
});
