import type { Box, Track } from "@/domains/workshop-stock/intake-tracker";
import { SETTLE_MS } from "@/domains/workshop-stock/intake-tracker";

/**
 * The camera table's live overlay, drawn on a canvas over the video. It only shows
 * what the tracker and the save really say: a red reticle closing in as an object
 * settles, a scan line while its label is being read, solid red when it needs a
 * person, and a green lock with a flash the moment it is logged.
 */

export type OverlayTone = "settling" | "reading" | "needs" | "logged" | "touching" | "hidden";

export interface OverlayTag {
  tone: OverlayTone;
  title: string | null;
  detail: string | null;
}

interface Remembered extends Box {
  loggedAt: number | null;
}

export interface OverlayColours {
  success: string;
  danger: string;
  warning: string;
  accent: string;
  ink: string;
  mono: string;
}

export function readOverlayColours(el: HTMLElement): OverlayColours {
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    success: read("--state-success", "#3ddc84"),
    danger: read("--state-danger", "#ff5a4f"),
    warning: read("--state-warning", "#ffb020"),
    accent: read("--accent-yellow", "#ffcc00"),
    ink: read("--surface-subtle", "#0a111e"),
    mono: style.fontFamily || "ui-monospace, monospace",
  };
}

/** Where the video actually sits inside its letterboxed element, in CSS pixels. */
export function videoArea(boxW: number, boxH: number, vw: number, vh: number) {
  const scale = Math.min(boxW / vw, boxH / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const l = Math.max(8, Math.min(22, Math.min(w, h) * 0.28));
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
    ctx.moveTo(cx + dx * l, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * l);
  }
  ctx.stroke();
}

function fit(ctx: CanvasRenderingContext2D, text: string, room: number): string {
  let out = text;
  while (out.length > 4 && ctx.measureText(out).width > room) out = `${out.slice(0, -2).trimEnd()}…`;
  return out;
}

function plate(ctx: CanvasRenderingContext2D, c: OverlayColours, colour: string, tag: OverlayTag, x: number, y: number, w: number, h: number, area: { x: number; y: number; w: number; h: number }) {
  if (!tag.title) return;
  // On a small picture a plate wider than its object would cover its neighbours.
  const compact = area.w < 600;
  const room = Math.max(w, compact ? 60 : 180) - 14;
  ctx.font = `700 13px ${c.mono}`;
  const title = fit(ctx, tag.title, room);
  const titleW = ctx.measureText(title).width;
  ctx.font = `500 12px ${c.mono}`;
  const detail = tag.detail && !compact ? fit(ctx, tag.detail, room) : null;
  const detailW = detail ? ctx.measureText(detail).width : 0;
  const pw = Math.max(titleW, detailW) + 14;
  const ph = detail ? 40 : 22;
  const py = y - ph - 5 >= area.y ? y - ph - 5 : y + h + 5;
  const px = Math.max(area.x, Math.min(x, area.x + area.w - pw));
  ctx.fillStyle = colour;
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = c.ink;
  ctx.font = `700 13px ${c.mono}`;
  ctx.fillText(title, px + 7, py + 11);
  if (detail) {
    ctx.font = `500 12px ${c.mono}`;
    ctx.fillText(detail, px + 7, py + 29);
  }
}

export interface DrawInput {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  tracks: readonly Track[];
  describe: (track: Track) => OverlayTag;
  memory: Map<number, Remembered>;
  colours: OverlayColours;
  now: number;
  running: boolean;
  /** 0–1 while the empty table is being read */
  calibrating: number | null;
  reducedMotion: boolean;
  /** the table area, when one has been set: everything outside it is ignored */
  zone: Box | null;
  /** where an arm is, so it's plain it has been seen and isn't being counted */
  armCells: { gw: number; gh: number; cells: Uint8Array } | null;
  /** still things at the edge of the area, which are never counted */
  atEdge: readonly Box[];
  /** the object whose card the mouse is on */
  highlight: number | null;
}

export function drawOverlay({ canvas, video, tracks, describe, memory, colours: c, now, running, calibrating, reducedMotion, zone, armCells, atEdge, highlight }: DrawInput): void {
  if (!video.videoWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.textBaseline = "middle";
  const area = videoArea(cw, ch, video.videoWidth, video.videoHeight);

  if (zone) {
    // Outside the table area is dimmed: that part of the picture isn't being looked at.
    const zx = area.x + zone.x * area.w;
    const zy = area.y + zone.y * area.h;
    const zw = zone.w * area.w;
    const zh = zone.h * area.h;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = c.ink;
    ctx.fillRect(area.x, area.y, area.w, zy - area.y);
    ctx.fillRect(area.x, zy + zh, area.w, area.y + area.h - zy - zh);
    ctx.fillRect(area.x, zy, zx - area.x, zh);
    ctx.fillRect(zx + zw, zy, area.x + area.w - zx - zw, zh);
    ctx.globalAlpha = 1;
  }

  if (calibrating !== null) {
    const y = area.y + area.h * calibrating;
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = c.accent;
    ctx.fillRect(area.x, area.y, area.w, y - area.y);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.w, y);
    ctx.stroke();
    return;
  }
  if (!running) return;

  // The working area: anything touching its edge is taken for an arm.
  const inset = area.w / 80;
  const work = zone
    ? { x: area.x + zone.x * area.w + inset, y: area.y + zone.y * area.h + inset, w: zone.w * area.w - inset * 2, h: zone.h * area.h - inset * 2 }
    : { x: area.x + inset, y: area.y + inset, w: area.w - inset * 2, h: area.h - inset * 2 };
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.5;
  brackets(ctx, work.x, work.y, work.w, work.h);
  ctx.globalAlpha = 1;

  // An arm: a faint wash, so it's plain it has been seen and isn't being counted.
  if (armCells) {
    const cellW = area.w / armCells.gw;
    const cellH = area.h / armCells.gh;
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = c.accent;
    for (let cy = 0; cy < armCells.gh; cy++) {
      for (let cx = 0; cx < armCells.gw; cx++) {
        if (armCells.cells[cy * armCells.gw + cx]) ctx.fillRect(area.x + cx * cellW, area.y + cy * cellH, cellW + 0.5, cellH + 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Something still at the edge: half out of shot, so it will never be counted. Say so.
  for (const box of atEdge) {
    const x = area.x + box.x * area.w;
    const y = area.y + box.y * area.h;
    const w = box.w * area.w;
    const h = box.h * area.h;
    ctx.strokeStyle = c.warning;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    plate(ctx, c, c.warning, { tone: "touching", title: "AT THE EDGE · NOT COUNTED", detail: null }, x, y, w, h, area);
  }

  const live = new Set<number>();
  for (const track of tracks) {
    // Something nobody brought isn't an object yet, so it gets no box.
    if (track.arrived === false) continue;
    live.add(track.id);
    const tag = describe(track);
    if (tag.tone === "hidden") continue;
    const seen = memory.get(track.id);
    const t = reducedMotion || !seen ? 1 : 0.35;
    const box: Remembered = {
      x: seen ? seen.x + (track.box.x - seen.x) * t : track.box.x,
      y: seen ? seen.y + (track.box.y - seen.y) * t : track.box.y,
      w: seen ? seen.w + (track.box.w - seen.w) * t : track.box.w,
      h: seen ? seen.h + (track.box.h - seen.h) * t : track.box.h,
      loggedAt: tag.tone === "logged" ? seen?.loggedAt ?? now : null,
    };
    memory.set(track.id, box);
    const x = area.x + box.x * area.w;
    const y = area.y + box.y * area.h;
    const w = box.w * area.w;
    const h = box.h * area.h;
    const colour = tag.tone === "logged" ? c.success : tag.tone === "touching" ? c.warning : c.danger;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;

    if (tag.tone === "settling") {
      const progress = Math.min(1, (now - track.stableSince) / SETTLE_MS);
      const open = reducedMotion ? 0 : (1 - progress) * 14;
      ctx.lineWidth = 2;
      brackets(ctx, x - open, y - open, w + open * 2, h + open * 2);
      continue;
    }

    if (tag.tone === "logged") {
      const age = now - (box.loggedAt ?? now);
      const flash = reducedMotion ? 0 : Math.max(0, 1 - age / 600);
      ctx.globalAlpha = 0.08 + flash * 0.34;
      ctx.fillRect(x, y, w, h);
      if (flash > 0) {
        const grow = (1 - flash) * 18;
        ctx.globalAlpha = flash;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - grow, y - grow, w + grow * 2, h + grow * 2);
      }
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    } else {
      const pulse = tag.tone === "needs" && !reducedMotion ? 0.5 + 0.5 * Math.sin(now / 280) : 0.5;
      ctx.globalAlpha = 0.08 + pulse * 0.1;
      ctx.fillRect(x, y, w, h);
      if (tag.tone === "needs" || tag.tone === "touching") {
        ctx.globalAlpha = 0.5 + pulse * 0.4;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    brackets(ctx, x, y, w, h);
    if (highlight === track.id) {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 5, y - 5, w + 10, h + 10);
      ctx.strokeStyle = colour;
    }

    if (tag.tone === "reading" && !reducedMotion) {
      const sweep = (now % 1100) / 1100;
      const ly = y + h * (sweep < 0.5 ? sweep * 2 : 2 - sweep * 2);
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, ly);
      ctx.lineTo(x + w, ly);
      ctx.stroke();
    }
    plate(ctx, c, colour, tag, x, y, w, h, area);
  }
  for (const id of memory.keys()) if (!live.has(id)) memory.delete(id);
}

let audio: AudioContext | null = null;

/** Called from a click: browsers only allow sound once someone has pressed something. */
export function unlockSound(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = null;
  }
}

/** So the person at the table doesn't have to look up: a rising pair when logged, a low pair when it needs them. */
export function playCue(kind: "logged" | "needs"): void {
  if (!audio || audio.state !== "running") return;
  const notes = kind === "logged" ? [880, 1320] : [330, 262];
  notes.forEach((freq, i) => {
    const start = audio!.currentTime + i * 0.09;
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    osc.type = kind === "logged" ? "sine" : "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
    osc.connect(gain).connect(audio!.destination);
    osc.start(start);
    osc.stop(start + 0.16);
  });
}
