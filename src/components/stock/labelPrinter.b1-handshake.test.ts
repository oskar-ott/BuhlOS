import { describe, expect, it, vi } from "vitest";

/**
 * Connecting to a B1, checked against a real B1's bytes: the handshake below
 * was captured from a NIIMBOT B1 (hardware 5.10, firmware 5.22) and ships with
 * the library's own tests (MultiMote/niimbluelib src/test/dumps.ts, MIT). The
 * real library plays it back through its virtual client, so this is our
 * connectPrinter() against what an actual B1 says — not our guess of it.
 */
const B1_V5_22 = `
>> 03 55 55 c1 01 01 c1 aa aa (Connect)
<< 55 55 c2 01 03 c0 aa aa (In_Connect)
>> 55 55 a5 01 01 a5 aa aa (PrinterStatusData)
<< 55 55 b5 10 30 30 03 20 00 c8 00 00 00 0f 01 02 04 01 98 00 df aa aa (In_PrinterStatusData)
>> 55 55 40 01 08 49 aa aa (PrinterInfo)
<< 55 55 48 02 10 00 5a aa aa (In_PrinterInfoPrinterCode)
>> 55 55 40 01 0b 4a aa aa (PrinterInfo)
<< 55 55 4b 0a 47 33 32 37 30 37 31 31 38 35 3a aa aa (In_PrinterInfoSerialNumber)
>> 55 55 40 01 0d 4c aa aa (PrinterInfo)
<< 55 55 4d 06 27 03 07 17 6e 82 93 aa aa (In_PrinterInfoBluetoothAddress)
>> 55 55 40 01 0a 4b aa aa (PrinterInfo)
<< 55 55 4a 01 04 4f aa aa (In_PrinterInfoChargeLevel)
>> 55 55 40 01 07 46 aa aa (PrinterInfo)
<< 55 55 47 01 01 47 aa aa (In_PrinterInfoAutoShutDownTime)
>> 55 55 40 01 03 42 aa aa (PrinterInfo)
<< 55 55 43 01 01 43 aa aa (In_PrinterInfoLabelType)
>> 55 55 40 01 0c 4d aa aa (PrinterInfo)
<< 55 55 4c 02 05 0a 41 aa aa (In_PrinterInfoHardWareVersion)
>> 55 55 40 01 09 48 aa aa (PrinterInfo)
<< 55 55 49 02 05 16 58 aa aa (In_PrinterInfoSoftWareVersion)
>> 55 55 dc 01 03 de aa aa (Heartbeat)
<< 55 55 de 0a 05 0a 05 16 01 80 02 02 01 00 48 aa aa (In_HeartbeatBasic)
>> 55 55 dc 01 04 d9 aa aa (Heartbeat)
<< 55 55 d9 09 20 41 04 4d 00 00 01 00 00 f9 aa aa (In_HeartbeatAdvanced2)
>> 55 55 1a 01 01 1a aa aa (RfidInfo)
<< 55 55 1b 27 88 1d 7e 4f d9 97 00 00 08 31 30 32 36 32 32 36 30 10 50 5a 31 47 32 32 31 33 32 32 30 30 34 32 30 35 01 14 00 99 01 3d aa aa (In_RfidInfo)
`;

vi.mock("@mmote/niimbluelib", async () => {
  const real = await vi.importActual<typeof import("@mmote/niimbluelib")>("@mmote/niimbluelib");
  /** the "Bluetooth" client is the library's virtual one, answering with the real B1's bytes */
  class RecordedB1 extends real.NiimbotVirtualClient {
    constructor() {
      super();
      this.setHeartbeatAutoStart(false);
      this.loadHexDump(B1_V5_22);
    }
  }
  return { ...real, NiimbotBluetoothClient: RecordedB1 };
});

describe("connecting to a real B1's handshake", () => {
  it("is found as a B1: B1 print sequence, 384-dot head, upright, 203 dpi — so labels are drawn for it", async () => {
    const p = await import("./labelPrinter");
    const printer = await p.connectPrinter("bluetooth");
    expect(printer).toMatchObject({ model: "B1", printheadPixels: 384, direction: "top", link: "bluetooth" });
    const lib = await import("@mmote/niimbluelib");
    const meta = lib.getPrinterMetaByModel(lib.PrinterModel.B1)!;
    expect(meta.dpi).toBe(203);
    expect(meta.densityDefault).toBe(3);
    expect(meta.paperTypes).toContain(lib.LabelType.WithGaps);
    await p.disconnectPrinter();
    expect(p.connectedPrinter()).toBeNull();
  });
});
