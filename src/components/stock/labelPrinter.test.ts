import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ean13Modules, fitToPrinthead, labelSize, layoutLabel } from "@/domains/workshop-stock/label";

/**
 * Printing a label straight to the NIIMBOT (owner, 2026-11-03: a B1, on the
 * office computer, in Chrome). The printer itself can't be in a test, so:
 *  - the print sequence and what the person is told are checked against a
 *    stand-in for the library;
 *  - the real library encodes a real B1 label, to show the data fits the
 *    head and the bars come out as the barcode.
 * A real print on the B1 is still the proof (docs/workshop-stock.md).
 */

type Job = { printInit: () => Promise<void>; printPage: (img: unknown, q: number) => Promise<void>; waitForFinished: () => Promise<void>; printEnd: () => Promise<boolean> };

const calls: string[] = [];
let connectImpl: () => Promise<{ deviceName?: string }>;
let metaImpl: () => unknown;
let jobImpl: Partial<Job>;
let lastClient: FakeClient | null = null;

class FakeClient {
  handlers: Record<string, Array<() => void>> = {};
  protocol = {
    newPrintTask: (name: string, opts: Record<string, unknown>) => {
      calls.push(`task ${name} ${JSON.stringify(opts)}`);
      const job: Job = {
        printInit: async () => { calls.push("init"); },
        printPage: async (_img, q) => { calls.push(`page x${q}`); },
        waitForFinished: async () => { calls.push("finished"); },
        printEnd: async () => { calls.push("end"); return true; },
        ...jobImpl,
      };
      return job;
    },
  };
  constructor(public kind: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test needs the client the module made
    lastClient = this;
  }
  connect() { calls.push(`connect ${this.kind}`); return connectImpl(); }
  async disconnect() { calls.push("disconnect"); }
  beating = true;
  isHeartbeatStarted() { return this.beating; }
  stopHeartbeat() { calls.push("heartbeat off"); this.beating = false; }
  startHeartbeat() { calls.push("heartbeat on"); this.beating = true; }
  isConnected() { return true; }
  getModelMetadata() { return metaImpl(); }
  getPrintTaskType() { return (metaImpl() as { model?: string } | undefined)?.model === "B1" ? "B1" : undefined; }
  on(ev: string, fn: () => void) { (this.handlers[ev] ??= []).push(fn); }
  emit(ev: string) { for (const fn of this.handlers[ev] ?? []) fn(); }
}

/** a label already at the B1's full head width, so nothing needs padding */
const CANVAS = { width: 384, height: 240 } as HTMLCanvasElement;

const B1 = { model: "B1", dpi: 203, printDirection: "top", printheadPixels: 384, densityDefault: 3 };

vi.mock("@mmote/niimbluelib", () => ({
  NiimbotBluetoothClient: class extends FakeClient { constructor() { super("bluetooth"); } },
  NiimbotSerialClient: class extends FakeClient { constructor() { super("usb"); } },
  ImageEncoder: { encodeCanvas: (_c: unknown, _color: number, dir: string) => { calls.push(`encode ${dir}`); return { rows: 1, cols: 8, rowsData: [] }; } },
  PageColorType: { SingleColor: 0 },
  LabelType: { WithGaps: 1 },
}));

async function load() {
  vi.resetModules();
  return import("./labelPrinter");
}

beforeEach(() => {
  calls.length = 0;
  lastClient = null;
  connectImpl = async () => ({ deviceName: "B1-H1234" });
  metaImpl = () => B1;
  jobImpl = {};
});
afterEach(() => vi.unstubAllGlobals());

describe("print straight to the NIIMBOT", () => {
  it("connects once, then each label is init → page → wait → end, at the B1's own density, upright", async () => {
    const p = await load();
    const seen: Array<string | null> = [];
    p.onPrinterChange((x) => seen.push(x?.name ?? null));
    const printer = await p.connectPrinter("bluetooth");
    expect(printer).toMatchObject({ name: "B1-H1234", model: "B1", printheadPixels: 384, direction: "top", link: "bluetooth" });
    expect(p.connectedPrinter()).toBe(printer);
    await p.printCanvas(CANVAS, 1);
    await p.printCanvas(CANVAS, 1);
    expect(calls.filter((c) => c.startsWith("connect"))).toEqual(["connect bluetooth"]);
    expect(calls.slice(calls.indexOf("connect bluetooth") + 1, calls.indexOf("heartbeat on") + 1)).toEqual([
      "encode top",
      'task B1 {"totalPages":1,"density":3,"labelType":1}',
      "heartbeat off", // the background ping can't sit between the print's messages
      "init",
      "page x1",
      "finished",
      "end",
      "heartbeat on",
    ]);
    expect(seen).toEqual(["B1-H1234"]);
  });

  it("closing Chrome's printer chooser is not an error", async () => {
    const p = await load();
    connectImpl = async () => { throw Object.assign(new Error("User cancelled the requestDevice() chooser."), { name: "NotFoundError" }); };
    await expect(p.connectPrinter("bluetooth")).resolves.toBeNull();
    expect(p.connectedPrinter()).toBeNull();
    connectImpl = async () => { throw Object.assign(new Error("No port selected by the user."), { name: "NotFoundError" }); };
    await expect(p.connectPrinter("usb")).resolves.toBeNull();
  });

  it("a printer that won't connect says what to check — Bluetooth names the NIIMBOT app on a phone", async () => {
    const p = await load();
    connectImpl = async () => { throw new Error("GATT Server is disconnected."); };
    await expect(p.connectPrinter("bluetooth")).rejects.toThrow(/switched on.*NIIMBOT app on any phone/);
    await expect(p.connectPrinter("usb")).rejects.toThrow(/cable/);
    expect(p.connectedPrinter()).toBeNull();
  });

  it("a model it can't print to, or a 300 dpi one, is refused — and Save image is the way", async () => {
    const p = await load();
    metaImpl = () => undefined;
    await expect(p.connectPrinter("bluetooth")).rejects.toThrow(/isn't one BuhlOS can print to yet.*Save image/);
    metaImpl = () => ({ ...B1, model: "B1", dpi: 300 });
    await expect(p.connectPrinter("bluetooth")).rejects.toThrow(/300 dpi.*Save image/);
    expect(p.connectedPrinter()).toBeNull();
  });

  it("a printer that drops (switched off, out of range) is forgotten, so the next Print connects again", async () => {
    const p = await load();
    const seen: Array<string | null> = [];
    p.onPrinterChange((x) => seen.push(x?.name ?? null));
    await p.connectPrinter("bluetooth");
    lastClient!.emit("disconnect");
    expect(p.connectedPrinter()).toBeNull();
    expect(seen).toEqual(["B1-H1234", null]);
    await expect(p.printCanvas(CANVAS)).rejects.toThrow(/isn't connected/);
  });

  it("a refused job says why in plain words, and the job is still ended", async () => {
    const p = await load();
    await p.connectPrinter("bluetooth");
    jobImpl = { waitForFinished: async () => { throw Object.assign(new Error("Print error"), { reasonId: 1 }); } };
    await expect(p.printCanvas(CANVAS)).rejects.toThrow("The printer's lid is open. Shut it and try again.");
    expect(calls.slice(-2)).toEqual(["end", "heartbeat on"]);
    expect(p.printFailureCopy(2)).toMatch(/out of labels/);
    expect(p.printFailureCopy(3)).toMatch(/battery/);
    expect(p.printFailureCopy(undefined)).toMatch(/didn't print/);
  });

  it("only offers what this browser has: Chrome on a computer has both, Safari/Firefox neither", async () => {
    const p = await load();
    vi.stubGlobal("navigator", { bluetooth: {}, serial: {} });
    expect(p.printerLinks()).toEqual({ bluetooth: true, usb: true });
    vi.stubGlobal("navigator", {});
    expect(p.printerLinks()).toEqual({ bluetooth: false, usb: false });
  });
});

describe("print straight to the NIIMBOT — what could hang or break", () => {
  it("a print that never reports finished gives up after the timeout instead of sitting on Printing…", async () => {
    vi.useFakeTimers();
    try {
      const p = await load();
      await p.connectPrinter("bluetooth");
      jobImpl = { waitForFinished: () => new Promise<void>(() => undefined) };
      const done = p.printCanvas(CANVAS).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(p.PRINT_TIMEOUT_MS + 10);
      expect(await done).toMatch(/didn't say it had finished/);
      expect(calls.slice(-2)).toEqual(["end", "heartbeat on"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("works whether the bundler hands back the library's exports directly or under default", async () => {
    vi.resetModules();
    vi.doMock("@mmote/niimbluelib", () => ({
      NiimbotBluetoothClient: undefined, // only under default, as some bundlers wrap CommonJS
      default: {
        NiimbotBluetoothClient: class extends FakeClient { constructor() { super("bluetooth"); } },
        NiimbotSerialClient: class extends FakeClient { constructor() { super("usb"); } },
        ImageEncoder: { encodeCanvas: () => ({ rows: 1, cols: 8, rowsData: [] }) },
        PageColorType: { SingleColor: 0 },
        LabelType: { WithGaps: 1 },
      },
    }));
    try {
      const p = await import("./labelPrinter");
      await expect(p.connectPrinter("bluetooth")).resolves.toMatchObject({ model: "B1" });
      await p.printCanvas(CANVAS);
      expect(calls).toContain("page x1");
    } finally {
      vi.doUnmock("@mmote/niimbluelib");
    }
  });
});

describe("the real library encodes a B1 label the printer can take", () => {
  it("a 50 × 30 label fitted to the head is 384 dots across, packs without error, and the bars read back as the code", async () => {
    const lib = await vi.importActual<typeof import("@mmote/niimbluelib")>("@mmote/niimbluelib");
    const code = "2112345678900"; // a valid in-store EAN-13
    const lay = layoutLabel(fitToPrinthead(labelSize("50x30"), 384, "top"), "Conduit saddle 20mm", "Shelf A2");
    const modules = ean13Modules(code)!;
    const source = {
      width: lay.width,
      height: lay.height,
      getPixelColor(x: number, y: number) {
        const inBars = y >= lay.barsY && y < lay.barsY + lay.barsHeight && x >= lay.barsX && x < lay.barsX + 95 * lay.module;
        return inBars && modules[Math.floor((x - lay.barsX) / lay.module)] === "1" ? 0x000000 : 0xffffff;
      },
    };
    const image = lib.ImageEncoder.encode(source, lib.PageColorType.SingleColor, "top");
    expect(image.cols).toBe(384);
    expect(image.rows).toBe(240);
    const packets = lib.PacketGenerator.writeImageData(image, { printheadPixels: 384 });
    expect(packets.length).toBeGreaterThan(0);
    // read one bar row back, one dot per module, like a scanner would
    const row = image.rowsData.find((r) => r.dataType === "pixels" && r.rowDataBlack)!;
    const bits: number[] = [];
    row.rowDataBlack!.forEach((byte) => { for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1); });
    const read = Array.from({ length: 95 }, (_, i) => bits[lay.barsX + i * lay.module]).join("");
    expect(read).toBe(modules);
  });
});
