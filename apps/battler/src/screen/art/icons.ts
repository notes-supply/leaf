import { PAL } from "@sequoia-leaf/figures/pal.ts";
import { readRows } from "@sequoia-leaf/figures/rows.ts";
/**
 * The small pictures: one for every trait, component, finished item, tool and boon, the three kinds of
 * room, the Wilds' rules, and the few signs the buttons carry. Typed as rows of letters like the
 * figures and kept as text (`icons.txt`), baked once with a dark edge, and handed out as fresh little
 * canvases to put on the page.
 *
 * Items (`RAID-BOARD.md` section 10): a component bare, in its own colour and shape; a finished item
 * in a frame of its two components' lights, one above the diagonal and one below; an emblem, the sign
 * of the trait it grants, in a frame of that trait's colour. Framed means made. Each is first a grid
 * of colours (`itemGrid`, `heldGrid`), which the tests read, then a picture.
 */
import { CREAM, GOLD, INK, PAPER } from "@sequoia-leaf/kit/palette.ts";
import { bitmap, outlined, paint } from "@sequoia-leaf/kit/pix.ts";
import { makeCanvas } from "@sequoia-leaf/kit/util.ts";
import { type BoonId, boonIn } from "@sequoia-leaf/raid/content/boons.ts";
import { type Catalog, catalogAt } from "@sequoia-leaf/raid/content/catalog.ts";
import {
  type ComponentId,
  type EmblemId,
  emblemTrait,
  halvesOf,
  isComponentId,
  isEmblemId,
  isFinishedId,
} from "@sequoia-leaf/raid/content/items.ts";
import { LAST_ERA } from "@sequoia-leaf/raid/content/releases.ts";
import type { RoomKind } from "@sequoia-leaf/raid/content/rooms.ts";
import type { RackItem } from "@sequoia-leaf/raid/content/tools.ts";
import type { TraitId } from "@sequoia-leaf/raid/content/traits.ts";
import type { RuleId } from "@sequoia-leaf/raid/content/wilds.ts";

import text from "./icons.txt";
import { COMPONENT_TONE, TRAIT_COLOUR } from "./pal.ts";

/** The catalogue with every release open: there is a picture of anything any release brings. */
const NOW = catalogAt(LAST_ERA);
/** An emblem's picture is the sign of the trait it grants. */
const grantedOf = (id: EmblemId): TraitId => emblemTrait(NOW, id);

const ROWS = readRows(text);
/** A picture's rows from `icons.txt`, by its kind and its id. */
const rowsOf = (kind: "trait" | "item" | "held" | "room" | "rule" | "glyph" | "level", id: string): readonly string[] =>
  ROWS.get(`${kind} ${id}`) ?? [];

/** The signs the buttons and the purse carry. */
export const GLYPHS = [
  "acorn",
  "rustle",
  "pin",
  "up",
  "play",
  "fast",
  "skip",
  "book",
  "help",
  "door",
  "swords",
  "hand",
  "figure",
  "brush",
  "leaf",
  "coin",
  "flame",
  "frost",
  "ring",
  "eye",
] as const;
export type Glyph = (typeof GLYPHS)[number];

const baked = new Map<string, HTMLCanvasElement>();
function bakedOf(key: string, rows: readonly string[], edge = true, pal = PAL): HTMLCanvasElement {
  let c = baked.get(key);
  if (!c) {
    const pic = bitmap(rows, pal);
    c = edge ? outlined(pic, INK) : pic;
    baked.set(key, c);
  }
  return c;
}
/** A fresh copy of a baked picture, to put on the page (a canvas can only be in one place). */
function copy(src: HTMLCanvasElement): HTMLCanvasElement {
  const { c, g } = makeCanvas(src.width, src.height);
  g.drawImage(src, 0, 0);
  return c;
}

// ---------- items as grids of colours ----------

/** A picture as rows of colours; null is clear. */
export type Grid = readonly (readonly (string | null)[])[];
const widthOf = (grid: Grid): number => grid.reduce((w, row) => Math.max(w, row.length), 0);
/** Typed rows as a grid, every row as wide as the widest. */
function gridOf(rows: readonly string[]): Grid {
  const w = rows.reduce((m, row) => Math.max(m, row.length), 0);
  return rows.map((row) => Array.from({ length: w }, (_, x) => PAL[row.charAt(x)] ?? null));
}
/** A grid painted, with an edge of `colour` round it. */
function baking(key: string, grid: () => Grid, colour: string): HTMLCanvasElement {
  let c = baked.get(key);
  if (!c) {
    const g = grid();
    c = outlined(
      paint(widthOf(g), g.length, (x, y) => g[y]?.[x] ?? null),
      colour,
    );
    baked.set(key, c);
  }
  return c;
}

/** A square grid `n` wide, each pixel's colour asked for in turn. */
const square = (n: number, at: (x: number, y: number) => string | null): Grid =>
  Array.from({ length: n }, (_row, y) => Array.from({ length: n }, (_pixel, x) => at(x, y)));

/** The ground inside a frame: the bench hollows' near-black. */
export const FRAME_GROUND = "#211228";
/** How big a framed picture is, frame and all: a component's size, so the two sit alike. */
export const FRAMED = 12;
/**
 * A picture centred in a frame one pixel wide on a dark ground, `FRAMED` square: the frame `a` above
 * the diagonal from the lower left corner to the upper right (and on it), `b` below it.
 */
export function framed(inner: Grid, a: string, b: string): Grid {
  const ox = Math.floor((FRAMED - widthOf(inner)) / 2);
  const oy = Math.floor((FRAMED - inner.length) / 2);
  const last = FRAMED - 1;
  return square(FRAMED, (x, y) => {
    if (x === 0 || y === 0 || x === last || y === last) return x + y <= last ? a : b;
    return inner[y - oy]?.[x - ox] ?? FRAME_GROUND;
  });
}
/** A component's light: its finished items' frames, and their held tiles, are drawn in it. */
const lightOf = (id: ComponentId): string => COMPONENT_TONE[id].light;

/**
 * A finished item as a figure holds it, 5 by 5: the first component's light above the diagonal, the
 * second's below, and the first's shade on it. Two of the same: one light with a cream middle.
 */
export function heldTile(a: ComponentId, b: ComponentId): Grid {
  return square(5, (x, y) => {
    if (a === b) return x === 2 && y === 2 ? CREAM : lightOf(a);
    return x + y < 4 ? lightOf(a) : x + y > 4 ? lightOf(b) : COMPONENT_TONE[a].shade;
  });
}

/** An item's picture as colours (a tool is typed as an item and drawn bare): see the module's head. */
export function itemGrid(id: RackItem): Grid {
  if (isEmblemId(id)) {
    const trait = grantedOf(id);
    return framed(gridOf(rowsOf("trait", trait)), TRAIT_COLOUR[trait], TRAIT_COLOUR[trait]);
  }
  if (isFinishedId(id)) {
    const [a, b] = halvesOf(NOW, id);
    return framed(gridOf(rowsOf("item", id)), lightOf(a), lightOf(b));
  }
  return gridOf(rowsOf("item", id));
}

/**
 * Halves a picture typed as letters: each square of two by two becomes the letter most of it is,
 * so a ten-pixel picture keeps its shape and colours at five.
 */
function halved(rows: readonly string[]): string[] {
  const out: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = "";
    for (let x = 0; x < (rows[0]?.length ?? 0); x += 2) {
      const seen = new Map<string, number>();
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const ch = rows[y + dy]?.[x + dx] ?? ".";
        if (ch !== ".") seen.set(ch, (seen.get(ch) ?? 0) + 1);
      }
      let best = ".";
      let most = 0;
      for (const [ch, n] of seen) {
        if (n <= most) continue;
        best = ch;
        most = n;
      }
      line += best;
    }
    out.push(line);
  }
  return out;
}

/**
 * What a figure holds, 5 by 5 (7 with its edge): a component its own small picture with the dark
 * edge; a finished item its held tile and an emblem its sign halved, both with a gold edge.
 */
export function heldGrid(id: RackItem): Grid {
  if (isComponentId(id)) return gridOf(rowsOf("held", id));
  if (isFinishedId(id)) return heldTile(...halvesOf(NOW, id));
  return gridOf(halved(isEmblemId(id) ? rowsOf("trait", grantedOf(id)) : rowsOf("item", id)));
}
/** The colour of a held picture's edge: dark for a component, gold for anything made. */
export const heldEdge = (id: RackItem): string => (isComponentId(id) ? INK : GOLD[2]);

// ---------- the pictures ----------

/** The kept picture of a trait, for drawing on the table. Do not put it on the page. */
export const traitPic = (id: TraitId): HTMLCanvasElement => bakedOf(`t:${id}`, rowsOf("trait", id));
export const traitIcon = (id: TraitId): HTMLCanvasElement => copy(traitPic(id));
/** The kept picture of an item or a tool, for drawing on the table. Do not put it on the page. */
export const itemPic = (id: RackItem): HTMLCanvasElement => baking(`i:${id}`, () => itemGrid(id), INK);
export const itemIcon = (id: RackItem): HTMLCanvasElement => copy(itemPic(id));
/** What a figure holds, as it is shown under its plate's bars. Do not put it on the page. */
export const heldPic = (id: RackItem): HTMLCanvasElement => baking(`h:${id}`, () => heldGrid(id), heldEdge(id));
export const glyphPic = (id: Glyph): HTMLCanvasElement => bakedOf(`g:${id}`, rowsOf("glyph", id), id !== "hand");
export const glyph = (id: Glyph): HTMLCanvasElement => copy(glyphPic(id));
/** A figure's level, 1 to 6, as a small green number: drawn beside its base, never among its stars. */
export const levelPic = (level: number): HTMLCanvasElement => bakedOf(`l:${level}`, rowsOf("level", String(level)));
export const roomIcon = (kind: RoomKind): HTMLCanvasElement => copy(bakedOf(`r:${kind}`, rowsOf("room", kind)));
/** The letters a rule's picture is typed in: the figures' and the board's own wood, for its hexes. */
const BOARD_PAL: Readonly<Record<string, string>> = { ...PAL, F: PAPER[1], Q: PAPER[0] };
/** A rule's picture, the same size for every rule: wherever the rule is shown, its pick, its room, its fight. */
export const ruleIcon = (id: RuleId): HTMLCanvasElement =>
  copy(bakedOf(`u:${id}`, rowsOf("rule", id), true, BOARD_PAL));

/**
 * A boon's own picture as colours, if it has one: framed in its halves' lights when the catalogue
 * has it made by a recipe (An Extra Chair, two Knives, from Penguin Month), bare when not.
 */
export function boonGrid(cat: Catalog, id: BoonId): Grid | null {
  const rows = ROWS.get(`boon ${id}`);
  if (!rows) return null;
  const made = boonIn(cat, id).made;
  return made ? framed(gridOf(rows), lightOf(made[0]), lightOf(made[1])) : gridOf(rows);
}

/** A boon's picture, as the catalogue has it: its own, or for a charm its kin's sign hanging on a string. */
export function boonIcon(cat: Catalog, id: BoonId): HTMLCanvasElement {
  // A boon that is not a charm has a picture of its own; a charm is its kin's sign on a string.
  const made = boonIn(cat, id).made;
  const own = ROWS.has(`boon ${id}`)
    ? baking(`b:${id}:${made?.join("+") ?? ""}`, () => boonGrid(cat, id) ?? [], INK)
    : null;
  if (own) return copy(own);
  if (!isEmblemId(id)) return copy(glyphPic("acorn"));
  const sign = traitPic(grantedOf(id));
  const { c, g } = makeCanvas(sign.width, sign.height + 3);
  g.fillStyle = PAL.c ?? "#e9d8b8";
  g.fillRect(Math.floor(sign.width / 2) - 1, 0, 1, 3);
  g.fillRect(Math.floor(sign.width / 2) + 1, 0, 1, 3);
  g.fillRect(Math.floor(sign.width / 2), 0, 1, 1);
  g.drawImage(sign, 0, 3);
  return c;
}
