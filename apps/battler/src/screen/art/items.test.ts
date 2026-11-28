/**
 * The items' pictures (`RAID-BOARD.md` section 10), read as grids of colours with no canvas: their
 * sizes, the frames that say what a finished item is made of, a finished drawing's own colours (and
 * the five kept from today), the six components told apart by shape alone, and An Extra Chair framed
 * only from Penguin Month.
 */
import { describe, expect, test } from "bun:test";

import { BARK, CORAL, CREAM, EARTH, GOLD, GREEN, INK, LEAF, WATER } from "@sequoia-leaf/kit/palette.ts";
import { rgb } from "@sequoia-leaf/kit/pix.ts";
import { eraAt, RELEASES } from "@sequoia-leaf/raid";
import { catalogAt } from "@sequoia-leaf/raid/content/catalog.ts";
import {
  COMPONENT_IDS,
  type ComponentId,
  EMBLEM_IDS,
  emblemTrait,
  FINISHED_IDS,
  type FinishedId,
  halvesOf,
} from "@sequoia-leaf/raid/content/items.ts";
import { LAST_ERA } from "@sequoia-leaf/raid/content/releases.ts";

import { stacksOf } from "../stacks.ts";
import { boonGrid, FRAME_GROUND, FRAMED, type Grid, heldEdge, heldGrid, itemGrid } from "./icons.ts";
import { COMPONENT_TONE, TRAIT_COLOUR } from "./pal.ts";

const NOW = catalogAt(LAST_ERA);
const sizeOf = (g: Grid): readonly [number, number] => [Math.max(...g.map((row) => row.length)), g.length];
/** The frame's pixels, clockwise from the upper left corner, and the drawing inside it. */
const rimOf = (g: Grid): (string | null)[] =>
  g.flatMap((row, y) => row.filter((_, x) => [x, y].some((v) => v === 0 || v === FRAMED - 1)));
const insideOf = (g: Grid): (string | null)[] => g.slice(1, -1).flatMap((row) => row.slice(1, -1));

/** Every tone a component's drawings are made of: its shade and light, and the steps beside them. */
const FAMILY: Readonly<Record<Exclude<ComponentId, "knife">, readonly string[]>> = {
  thorn: ["#b0483a", CORAL, "#f4a08c"],
  plume: [GOLD[0], GOLD[1], GOLD[2]],
  glowcap: [...WATER],
  bark: [...EARTH],
  chestnut: [...GREEN, LEAF],
};
const familyOf = (tone: string): string =>
  Object.entries(FAMILY).find(([, tones]) => tones.includes(tone))?.[0] ?? tone;

/**
 * The finished items that keep today's drawing in their new frame, each read better than its redraw in
 * its components' colours (the lead's call, 2026-11-28). The frame carries their two colours. A
 * redraw in their colours fails the colour test until its item leaves this list.
 */
const KEPT: Readonly<Partial<Record<FinishedId, string>>> = {
  blackthorn: "A red fork read as a slingshot; the dark twig with white blossoms is blackthorn.",
  hummingbird: "The green bird is the hummingbird.",
  stump: "The orange rings read as the stump; in browns it sank.",
  hoard: "A green heap read as grapes.",
  fairyring: "A blue ring read as snowflakes; the ring of red caps reads as mushrooms.",
};
/** Whether a finished drawing's two largest colours are its two components' (one in three steps, for two of the same). */
function inItsColours(id: FinishedId): boolean {
  const [a, b] = halvesOf(NOW, id);
  const inside = insideOf(itemGrid(id)).filter((t): t is string => t !== null && t !== FRAME_GROUND);
  const counts = new Map<string, number>();
  for (const tone of inside) counts.set(familyOf(tone), (counts.get(familyOf(tone)) ?? 0) + 1);
  const largest = [...counts].toSorted((p, q) => q[1] - p[1]).map(([family]) => family);
  if (a !== b) return largest.slice(0, 2).toSorted().join() === [a, b].toSorted().join();
  return largest[0] === a && new Set(inside.filter((t) => familyOf(t) === a)).size >= 3;
}

/** Where a picture has a pixel. */
const silhouette = (g: Grid): Set<string> =>
  new Set(g.flatMap((row, y) => row.flatMap((c, x) => (c ? [`${x},${y}`] : []))));
/** The share of the pixels either covers that only one does: 0 for one shape, 1 for two that never meet. */
function apart(a: Grid, b: Grid): number {
  const [p, q] = [silhouette(a), silhouette(b)];
  const both = [...p].filter((k) => q.has(k)).length;
  return 1 - both / (p.size + q.size - both);
}
/** Every pair of components whose pictures (`grid`) are less than a fifth apart. */
const tooAlike = (grid: (id: ComponentId) => Grid): string[] =>
  COMPONENT_IDS.flatMap((a, i) =>
    COMPONENT_IDS.slice(i + 1).flatMap((b) => (apart(grid(a), grid(b)) < 0.2 ? [`${a}/${b}`] : [])),
  );
/** A tone's grey (its luminance, 0 to 255). */
const grey = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("items' pictures", () => {
  test("a component is 12 by 12 and 5 by 5 held; a finished item and an emblem are framed at a component's 12, held at 5 by 5 at most", () => {
    for (const id of COMPONENT_IDS)
      expect([id, sizeOf(itemGrid(id)), sizeOf(heldGrid(id))]).toEqual([id, [12, 12], [5, 5]]);
    for (const id of FINISHED_IDS)
      expect([id, sizeOf(itemGrid(id)), sizeOf(heldGrid(id))]).toEqual([id, [12, 12], [5, 5]]);
    // An emblem's held sign is its trait's halved: a sign 9 by 8 is 5 by 4.
    for (const id of EMBLEM_IDS) {
      const [w, h] = sizeOf(heldGrid(id));
      expect([id, sizeOf(itemGrid(id)), w === 5 && h >= 4 && h <= 5]).toEqual([id, [FRAMED, FRAMED], true]);
    }
  });

  test("a finished item's frame is its first component's light above the diagonal and its second's below; an emblem's, its trait's colour all round", () => {
    for (const id of FINISHED_IDS) {
      const [a, b] = halvesOf(NOW, id).map((c) => COMPONENT_TONE[c].light);
      const g = itemGrid(id);
      expect([id, g[0]?.[0], g[0]?.[FRAMED - 1], g[FRAMED - 1]?.[FRAMED - 1]]).toEqual([id, a, a, b]);
    }
    for (const id of EMBLEM_IDS) {
      const colour = TRAIT_COLOUR[emblemTrait(NOW, id)];
      expect([id, new Set(rimOf(itemGrid(id)))]).toEqual([id, new Set([colour])]);
    }
  });

  test("a finished drawing's two largest colours are its two components'; two of the same, one colour in three steps; but the five kept from today", () => {
    const wrong: string[] = FINISHED_IDS.filter((id) => !inItsColours(id));
    expect(wrong.toSorted()).toEqual(Object.keys(KEPT).toSorted());
  });

  test("in grey, the six components are told apart by shape alone, and so is how a figure holds each", () => {
    expect(tooAlike(itemGrid)).toEqual([]);
    expect(tooAlike(heldGrid)).toEqual([]);
    // A held component is never the made items' square tile, and a made one's gold edge is far lighter than a component's ink.
    const square = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => INK));
    for (const id of COMPONENT_IDS) expect([id, apart(heldGrid(id), square) >= 0.15]).toEqual([id, true]);
    expect(grey(heldEdge("blackthorn")) - grey(heldEdge("thorn"))).toBeGreaterThan(150);
    expect(heldEdge("embercharm")).toBe(heldEdge("blackthorn"));
  });

  test("the Knife is on the rack and An Extra Chair framed in its cream only from Penguin Month's moment", () => {
    const moment = RELEASES.find((r) => r.id === "penguin-month")?.at ?? 0;
    const before = eraAt(moment - 1);
    const at = eraAt(moment);
    const rack = { rack: {}, era: before };
    expect(stacksOf(rack).parts.map((tile) => tile.item)).not.toContain("knife");
    expect(stacksOf({ ...rack, era: at }).parts.map((tile) => tile.item)).toContain("knife");
    const chair = (era: typeof at): Grid => boonGrid(catalogAt(era), "extrachair") ?? [];
    expect(sizeOf(chair(before))).toEqual([10, 10]);
    expect(new Set(rimOf(chair(at)))).toEqual(new Set([CREAM]));
    // Its frame is the Knife's light, and the Knife's own picture is stone and cream on a dark handle.
    expect(COMPONENT_TONE.knife.light).toBe(CREAM);
    expect(insideOf(itemGrid("knife")).filter((t) => t === BARK[2]).length).toBeGreaterThan(0);
  });
});
