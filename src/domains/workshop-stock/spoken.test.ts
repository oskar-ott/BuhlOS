import { describe, expect, it } from "vitest";
import type { NewItemDraft } from "./intake";
import { applySpoken, parseSpoken, spokenNumber } from "./spoken";

const words = (s: string) => s.split(" ");

describe("spokenNumber", () => {
  it.each([
    ["forty", "40"],
    ["40", "40"],
    ["twelve", "12"],
    ["twenty five", "25"],
    ["a hundred", "100"],
    ["two hundred and fifty", "250"],
    ["2 hundred", "200"],
    ["one thousand two hundred", "1200"],
    ["a dozen", "12"],
    ["two dozen", "24"],
    ["twelve point five", "12.5"],
    ["12.5", "12.5"],
  ])("%s → %s", (said, digits) => {
    expect(spokenNumber(words(said))).toBe(digits);
  });

  it.each(["point", "twenty thirty", "two three", "twelve five", "switch", "5 20", "and five"])("%s isn't one number", (said) => {
    expect(spokenNumber(words(said))).toBeNull();
  });
});

describe("parseSpoken", () => {
  it("splits what it is from how many", () => {
    expect(parseSpoken("clipsal iconic switch forty")).toMatchObject({ name: "Clipsal iconic switch", count: "40", unit: null });
    expect(parseSpoken("Clipsal Iconic switch, 40.")).toMatchObject({ name: "Clipsal Iconic switch", count: "40" });
    expect(parseSpoken("iconic switch two hundred and fifty")).toMatchObject({ name: "Iconic switch", count: "250" });
    expect(parseSpoken("iconic switch 1,000")).toMatchObject({ name: "Iconic switch", count: "1000" });
  });

  it("takes a number alone as how many", () => {
    expect(parseSpoken("forty")).toMatchObject({ name: null, count: "40" });
    expect(parseSpoken("15")).toMatchObject({ name: null, count: "15" });
    expect(parseSpoken("for")).toMatchObject({ name: null, count: "4" });
    expect(parseSpoken("to")).toMatchObject({ name: null, count: "2" });
  });

  it("only hears 'for' as a number when it's on its own", () => {
    expect(parseSpoken("cover plate for")).toMatchObject({ name: "Cover plate for", count: null });
  });

  it("leaves a number that belongs to the product in its name", () => {
    expect(parseSpoken("patch lead cat 6")).toMatchObject({ name: "Patch lead cat 6", count: null });
    expect(parseSpoken("weatherproof box IP 65")).toMatchObject({ name: "Weatherproof box IP 65", count: null });
    expect(parseSpoken("double power point")).toMatchObject({ name: "Double power point", count: null });
    expect(parseSpoken("sixteen amp breaker")).toMatchObject({ name: "Sixteen amp breaker", count: null });
    expect(parseSpoken("2.5 mil twin and earth")).toMatchObject({ name: "2.5 mil twin and earth", count: null });
    expect(parseSpoken("patch lead cat 6 times 10")).toMatchObject({ name: "Patch lead cat 6", count: "10" });
  });

  it("hears the unit", () => {
    expect(parseSpoken("2.5 mil twin and earth 100 metres")).toMatchObject({ name: "2.5 mil twin and earth", count: "100", unit: "metre" });
    expect(parseSpoken("twelve point five metres")).toMatchObject({ name: null, count: "12.5", unit: "metre" });
    expect(parseSpoken("cable ties three bags")).toMatchObject({ name: "Cable ties", count: "3", unit: "bag" });
    expect(parseSpoken("100 metres of TPS")).toMatchObject({ name: "TPS", count: "100", unit: "metre" });
  });

  it("doesn't take a unit in a name for a count", () => {
    expect(parseSpoken("100 metre roll")).toMatchObject({ name: "100 metre roll", count: null, unit: null });
    expect(parseSpoken("junction box")).toMatchObject({ name: "Junction box", count: null, unit: null });
  });

  it("hears the other ways people say how many", () => {
    expect(parseSpoken("forty of the iconic switches")).toMatchObject({ name: "Iconic switches", count: "40" });
    expect(parseSpoken("iconic switch 12 of them")).toMatchObject({ name: "Iconic switch", count: "12" });
    expect(parseSpoken("iconic switch x 12")).toMatchObject({ name: "Iconic switch", count: "12" });
    expect(parseSpoken("iconic switch quantity twelve")).toMatchObject({ name: "Iconic switch", count: "12" });
    expect(parseSpoken("box of screws")).toMatchObject({ name: "Box of screws", count: null });
  });

  it("lifts out where it goes, in the list's own spelling", () => {
    const known = ["Rack 3 Shelf 2, Bin 4", "Rack 3 Shelf 2, Bin 12"];
    expect(parseSpoken("iconic switch forty rack 3 shelf B bin 4", known)).toMatchObject({ name: "Iconic switch", count: "40", location: "Rack 3 Shelf 2, Bin 4" });
    expect(parseSpoken("rack three shelf bee bin twelve", known)).toMatchObject({ name: null, count: null, location: "Rack 3 Shelf 2, Bin 12" });
    expect(parseSpoken("goes to rack 3 shelf 2 bin 4 iconic switch", known)).toMatchObject({ name: "Iconic switch", location: "Rack 3 Shelf 2, Bin 4" });
    expect(parseSpoken("rack 3 shelf B bin 4", ["Rack 3 Shelf B, Bin 4"]).location).toBe("Rack 3 Shelf B, Bin 4");
  });

  it("says a bin the list doesn't have as it was said, and doesn't read a cable rack as a place", () => {
    expect(parseSpoken("rack 9 shelf C bin 2", ["Rack 3 Shelf 2, Bin 4"]).location).toBe("Rack 9 Shelf C, Bin 2");
    expect(parseSpoken("rack 9 shelf C")).toMatchObject({ location: "Rack 9 Shelf C", count: null });
    expect(parseSpoken("cable rack bracket")).toMatchObject({ name: "Cable rack bracket", location: null });
  });

  it("hears scratch that", () => {
    expect(parseSpoken("Scratch that.").scratch).toBe(true);
    expect(parseSpoken("scratch that plate").scratch).toBe(false);
    expect(parseSpoken("").name).toBeNull();
  });
});

describe("phrases that act", () => {
  it("hears 'add it' on its own, or on the end of a phrase", () => {
    expect(parseSpoken("add it")).toMatchObject({ save: true, name: null, count: null, words: "" });
    expect(parseSpoken("Log it.")).toMatchObject({ save: true, name: null });
    expect(parseSpoken("done")).toMatchObject({ save: true, name: null });
    expect(parseSpoken("iconic switch forty add it")).toMatchObject({ save: true, name: "Iconic switch", count: "40", words: "iconic switch forty" });
    expect(parseSpoken("iconic switch forty and log it")).toMatchObject({ save: true, name: "Iconic switch", count: "40" });
    expect(parseSpoken("for add it")).toMatchObject({ save: true, name: null, count: "4" });
    expect(parseSpoken("rack 3 shelf 2 bin 4 save it")).toMatchObject({ save: true, location: "Rack 3 Shelf 2, Bin 4" });
  });

  it("doesn't save on talk that only sounds close", () => {
    for (const said of ["iconic switch forty", "add a switch", "it's done now", "log book", "done it", "add"]) {
      expect(parseSpoken(said).save).toBe(false);
    }
  });

  it("hears the commands only as a whole phrase", () => {
    expect(parseSpoken("Undo that.").command).toBe("undo");
    expect(parseSpoken("undo").command).toBe("undo");
    expect(parseSpoken("not stock").command).toBe("ignore");
    expect(parseSpoken("read it again").command).toBe("again");
    expect(parseSpoken("stop listening").command).toBe("stop");
    expect(parseSpoken("undo switch")).toMatchObject({ command: null, name: "Undo switch" });
    expect(parseSpoken("not stock forty").command).toBeNull();
  });

  it("hears a pick by number or by place, never from a bare number", () => {
    expect(parseSpoken("number two").pick).toBe(2);
    expect(parseSpoken("number 3").pick).toBe(3);
    expect(parseSpoken("pick four").pick).toBe(4);
    expect(parseSpoken("number to").pick).toBe(2);
    expect(parseSpoken("the second one").pick).toBe(2);
    expect(parseSpoken("first").pick).toBe(1);
    for (const said of ["two", "2", "number twelve", "number zero", "first aid kit"]) {
      expect(parseSpoken(said).pick).toBeNull();
    }
  });

  it("a pick still reads as words for a card with no list", () => {
    expect(parseSpoken("number 2")).toMatchObject({ pick: 2, name: "Number 2", count: null });
  });
});

describe("applySpoken", () => {
  const start: NewItemDraft = { name: "Label read name", unit: "each", amount: "1", location: "Rack 1 Shelf 1, Bin 1", locationFrom: "switch", category: "switch", specs: { gang: "1" } };

  it("the first name replaces what the label gave, later phrases add to it", () => {
    const one = applySpoken(start, parseSpoken("clipsal iconic"), null);
    expect(one.draft.name).toBe("Clipsal iconic");
    const two = applySpoken(one.draft, parseSpoken("single switch"), one.memory);
    expect(two.draft.name).toBe("Clipsal iconic single switch");
  });

  it("a number first doesn't stop the first name replacing", () => {
    const one = applySpoken(start, parseSpoken("forty"), null);
    expect(one.draft).toMatchObject({ name: "Label read name", amount: "40" });
    const two = applySpoken(one.draft, parseSpoken("iconic switch"), one.memory);
    expect(two.draft).toMatchObject({ name: "Iconic switch", amount: "40" });
  });

  it("a later count replaces, and what wasn't said is left alone", () => {
    const one = applySpoken(start, parseSpoken("forty"), null);
    const two = applySpoken(one.draft, parseSpoken("fifty"), one.memory);
    expect(two.draft).toMatchObject({ amount: "50", location: "Rack 1 Shelf 1, Bin 1", locationFrom: "switch", category: "switch", specs: { gang: "1" } });
  });

  it("a spoken bin says it no longer came from a rule", () => {
    expect(applySpoken(start, parseSpoken("rack 3 shelf 2 bin 4"), null).draft).toMatchObject({ location: "Rack 3 Shelf 2, Bin 4", locationFrom: null });
  });

  it("scratch that goes back to before anyone spoke, and the next name replaces", () => {
    const one = applySpoken(start, parseSpoken("clips all iconic forty"), null);
    const two = applySpoken(one.draft, parseSpoken("rack 9 shelf 9 bin 9"), one.memory);
    const gone = applySpoken(two.draft, parseSpoken("scratch that"), two.memory);
    expect(gone.draft).toEqual(start);
    expect(gone.memory).toBeNull();
    expect(applySpoken(gone.draft, parseSpoken("clipsal iconic"), gone.memory).draft.name).toBe("Clipsal iconic");
  });

  it("scratch that with nothing said changes nothing", () => {
    expect(applySpoken(start, parseSpoken("scratch that"), null)).toEqual({ draft: start, memory: null });
  });

  it("a name can't grow past what the form takes", () => {
    const long = "x".repeat(170);
    expect(applySpoken(start, parseSpoken(long), null).draft.name).toHaveLength(160);
  });
});
