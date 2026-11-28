/**
 * The board's value budget (`RAID-BOARD.md` section 12), from the figures' own rows and the board's
 * tones, with no canvas: the faces' lightness, the grooves' step, the ink edge against a face, how
 * much of each figure sinks into a face, the two halves apart, and the components' colours apart.
 * Colours are CIELAB (sRGB, D65).
 */
import { describe, expect, test } from "bun:test";

import { artOf } from "@sequoia-leaf/figures/figures.ts";
import { FIGURE_PAL } from "@sequoia-leaf/figures/pal.ts";
import { CREAM, INK, WATER } from "@sequoia-leaf/kit/palette.ts";
import { rgb } from "@sequoia-leaf/kit/pix.ts";
import { eraOf, RELEASES } from "@sequoia-leaf/raid";
import { catalogAt } from "@sequoia-leaf/raid/content/catalog.ts";
import { SUMMON_IDS, TROUBLE_IDS, type UnitKind } from "@sequoia-leaf/raid/content/figures.ts";
import { hasTrueForm } from "@sequoia-leaf/raid/content/graid.ts";
import { COMPONENT_IDS } from "@sequoia-leaf/raid/content/items.ts";

import { COMMODORE, type Crew, CREW_FRONT, GROOTERS } from "../../../review/crew.ts";
import { BENCH, BOARD, CLOTHS, type HexTones, quietOf, RIM } from "./board.ts";
import { COMPONENT_TONE } from "./pal.ts";
import { WARM } from "./table.ts";

/** A channel (0 to 255) as linear light, and lightness's curve. */
const lin = (v: number): number => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
/** A colour as CIELAB: lightness, a, b. */
function lab(hex: string): readonly [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = lin((n >> 16) & 255);
  const g = lin((n >> 8) & 255);
  const b = lin(n & 255);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const L = (hex: string): number => lab(hex)[0];
const chroma = (hex: string): number => Math.hypot(lab(hex)[1], lab(hex)[2]);
const dE = (p: string, q: string): number => {
  const [a, b] = [lab(p), lab(q)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

/** A figure as the colours of its pixels, its ink edge left out. */
type Pixels = readonly string[];
const pixelsOf = (rows: readonly string[], pal: Readonly<Record<string, string>>): Pixels =>
  rows.flatMap((row) => row.split("").flatMap((ch) => (pal[ch] && pal[ch] !== INK ? [pal[ch]] : [])));
/** A person drawn from a skin, as the colours of their front. */
const person = (inks: Crew): Pixels => CREW_FRONT.flatMap((rows) => pixelsOf(rows, { ...inks }));

/** Every figure any release has, the forest's own, the summoned, Graid's five in their true forms. */
function everyone(): Map<string, Pixels> {
  const kinds = new Set<UnitKind>([...TROUBLE_IDS, ...SUMMON_IDS]);
  for (const r of RELEASES) for (const k of catalogAt(eraOf(r.id)).order) kinds.add(k);
  const out = new Map<string, Pixels>();
  for (const k of kinds) {
    const rows = artOf(k).rows;
    if (rows.length > 0) out.set(k, pixelsOf(rows, FIGURE_PAL));
    if (hasTrueForm(k)) out.set(`${k} true`, pixelsOf(artOf(k, "true").rows, FIGURE_PAL));
  }
  // People, drawn from a member's skin (the Commodore and his grooters): the review's made-up crew.
  out.set("commodore", person(COMMODORE));
  for (const [name, inks] of GROOTERS) out.set(`grooter ${name}`, person(inks));
  // Yule's bubble: its ring and the bright arc on it.
  out.set("bubble", [WATER[3], WATER[3], WATER[3], CREAM]);
  return out;
}
const EVERYONE = everyone();

/** The share of a figure's own pixels within ΔE 14 of a ground: they read as holes in it. */
const lost = (px: Pixels, ground: string): number => px.filter((c) => dE(c, ground) < 14).length / px.length;

/** A ground figures stand on: the bare board, or a cloth, with the rules its kind is held to. */
interface Surface {
  readonly near: HexTones;
  readonly far: HexTones;
  /** How much darker a groove is than its face while planning, and in a fight, at least; the most chroma; the ink edge's least step on each face; how far apart the halves are, at least. */
  readonly groove: number;
  readonly fight: number;
  readonly chroma: number;
  readonly edge: { readonly near: number; readonly far: number };
  readonly apart: number;
}
const BARE_RULES = { groove: 12, fight: 6, chroma: 22, edge: { near: 38, far: 28 }, apart: 8 } as const;
// A fight's groove is mixed 45% toward its face, so its step is 55% of planning's: on a cloth's far
// half, in the cloths' own tones, that is 5.1 (baize), 4.9 (velvet) and 4.3 (gingham). Held to 4, not 6.
const CLOTH_RULES = { groove: 7, fight: 4, chroma: 38, edge: { near: 25, far: 20 }, apart: 5 } as const;
const SURFACES: Readonly<Record<string, Surface>> = {
  bare: { ...BOARD, ...BARE_RULES },
  ...Object.fromEntries(Object.entries(CLOTHS).map(([id, t]) => [id, { ...t, ...CLOTH_RULES }])),
};
/** Each half of each surface, named. */
const FACES = Object.entries(SURFACES).flatMap(([id, s]) =>
  (["near", "far"] as const).map((side) => ({ name: `${id} ${side}`, side, t: s[side], s })),
);

/** Mud keeps only its edge and its face on your bare face (its picture wants a lighter tone): seen here when it changes. */
const MUD: Readonly<Record<string, number>> = {
  "bare near": 0.78,
  "bare far": 0.18,
  "baize near": 0,
  "baize far": 0,
  "plum near": 0,
  "plum far": 0,
  "gingham near": 0.78,
  "gingham far": 0.18,
};

const round2 = (v: number): number => Math.round(v * 100) / 100;
/** Every pair of components whose lights (or shades) are nearer than ΔE 30, with how near. */
const nearComponents = (tone: "light" | "shade"): string[] =>
  COMPONENT_IDS.flatMap((a, i) =>
    COMPONENT_IDS.slice(i + 1).flatMap((b) => {
      const d = dE(COMPONENT_TONE[a][tone], COMPONENT_TONE[b][tone]);
      return d < 30 ? [`${a}/${b} ${Math.round(d)}`] : [];
    }),
  );

describe("the board's value budget", () => {
  test("every rule is checked against the figures it is about", () => {
    // The 29 of the base set, the three new sets' figures, the forest's own, the summoned, Graid's five.
    expect(EVERYONE.size).toBeGreaterThanOrEqual(60);
  });

  test("1. faces are L* 26 to 48, grooves 12 to 26 darker (7 on a cloth; 6 to 14 in a fight, 4 on a cloth), chroma 22 or less (38 on a cloth)", () => {
    for (const { name, t, s } of FACES) {
      const step = L(t.face) - L(t.groove);
      const calm = L(quietOf(t).face) - L(quietOf(t).groove);
      // A lip is one pixel wide, held by its lightness alone: the velvet's, `dusk(SKY[4], 0.32)`, is
      // chroma 41, and any lip of that plum lighter than its face is over 38. That is its character.
      const tones = [t.face, t.groove, t.edge].filter((tone) => chroma(tone) > s.chroma);
      expect([name, L(t.face) >= 26, L(t.face) <= 48, L(t.lip) <= 54]).toEqual([name, true, true, true]);
      expect([name, step >= s.groove, step <= 26, calm >= s.fight, calm <= 14]).toEqual([name, true, true, true, true]);
      expect([name, tones]).toEqual([name, []]);
    }
    // The wood round the board is the bare board's. The stump's bark at its rim and the bench's plank
    // are their own wood, held by lightness alone: in the design's tones the rim's pale band is chroma
    // 31 and the bench's top 28, the stump's orange kept where it meets the grass.
    for (const tone of [BOARD.wood, BOARD.ring, BOARD.fleck]) expect([tone, chroma(tone) <= 22]).toEqual([tone, true]);
    for (const tone of [RIM.pale, RIM.dark, BENCH.plank, BENCH.top, BENCH.foot, BENCH.slat]) {
      expect([tone, L(tone) <= 48]).toEqual([tone, true]);
    }
    // Darkest to lightest: the wood, their half, your half.
    expect(L(BOARD.wood)).toBeLessThan(L(BOARD.far.face));
  });

  test("2. the ink edge against a face is at least 1.5 times the groove's step, and 38 on your bare face, 28 on theirs (25 and 20 on a cloth)", () => {
    for (const { name, side, t, s } of FACES) {
      const edge = L(t.face) - L(INK);
      expect([name, edge >= 1.5 * (L(t.face) - L(t.groove)), edge >= s.edge[side]]).toEqual([name, true, true]);
    }
  });

  test("3. no figure loses more than 30% of its fill to a face, but mud", () => {
    for (const { name, t } of FACES) {
      const sunk = [...EVERYONE]
        .filter(([kind, px]) => kind !== "mud" && lost(px, t.face) > 0.3)
        .map(([kind, px]) => `${kind} ${Math.round(lost(px, t.face) * 100)}%`);
      expect([name, sunk]).toEqual([name, []]);
    }
    const mud = EVERYONE.get("mud") ?? [];
    expect(Object.fromEntries(FACES.map(({ name, t }) => [name, round2(lost(mud, t.face))]))).toEqual(MUD);
  });

  test("the lanterns' pool lifts a face by 11 at most, at its heart", () => {
    // The pool was raised from the design's 0.09 to 0.13 to keep the table warm, which the lead
    // asked for. At its heart (the gap between the halves while planning, the middle rows' faces once
    // they close in a fight) it lifts a face by up to 11 L*; on the front row's middle hex while
    // planning, about 7. The design's 4 was already 5 there, and 7 at the heart, at 0.09. Not
    // further: at 0.16 your middle rows pass L* 52 and the velvet turns pink.
    for (const { name, t } of FACES) {
      const lit = `#${rgb(t.face)
        .map((v, i) => Math.min(255, v + Math.round((WARM[i] ?? 0) * BOARD.pool)))
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
      expect([name, Math.round(L(lit) - L(t.face)) <= 11]).toEqual([name, true]);
    }
  });

  test("4. your face is 8 to 12 lighter than theirs (5 to 12 on a cloth)", () => {
    for (const [id, s] of Object.entries(SURFACES)) {
      const apart = L(s.near.face) - L(s.far.face);
      expect([id, apart >= s.apart, apart <= 12]).toEqual([id, true, true]);
    }
  });

  test("5. the six components' lights differ pairwise by ΔE 30 or more, and so do their shades", () => {
    expect([COMPONENT_IDS.length, nearComponents("light"), nearComponents("shade")]).toEqual([6, [], []]);
  });
});
