/**
 * Every item's picture on one sheet (`RAID-BOARD.md` section 10): open the page with `?sheet=items`,
 * and `&zoom=3` to see it three times as big. The components and how a figure holds each, then in
 * grey; every finished item in its frame with its held tile; An Extra Chair before and from Penguin
 * Month, when two Knives make it; and every emblem, by the release that brings it. Drawn by the
 * game's own code.
 */
import { CREAM, GOLD, INK, STONE } from "@sequoia-leaf/kit/palette.ts";
import { write } from "@sequoia-leaf/kit/text.ts";
import { type Ctx, makeCanvas, must } from "@sequoia-leaf/kit/util.ts";
import { eraAt, eraOf, type ItemId, RELEASES } from "@sequoia-leaf/raid";
import { type Catalog, catalogAt } from "@sequoia-leaf/raid/content/catalog.ts";
import { FINISHED_IDS, itemName } from "@sequoia-leaf/raid/content/items.ts";
import { LAST_ERA } from "@sequoia-leaf/raid/content/releases.ts";

import { boonIcon, heldPic, itemPic } from "../src/screen/art/icons.ts";

const NOW = catalogAt(LAST_ERA);
/** An entry's width and height, and the room a heading takes. */
const ENTRY_W = 136;
const ENTRY_H = 18;
const HEAD = 14;
const COLUMNS = 3;
const MARGIN = 6;

/** A release as the sheet names it: its id in words, and the day it opens if it is not the base. */
function releaseName(id: string, at: number): string {
  const words = id.replaceAll("-", " ");
  const day = at > 0 ? ` (${new Date(at).toUTCString().slice(5, 11)})` : "";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${day}`;
}
/** The releases in order, each with the catalogue it opens. */
const OPENED: readonly { readonly name: string; readonly cat: Catalog }[] = RELEASES.filter(
  (r, i) => i === 0 || r.at !== RELEASES[i - 1]?.at,
).map((r) => ({ name: releaseName(r.id, r.at), cat: catalogAt(eraOf(r.id)) }));
/** What a release brings first, of one kind of item. */
function broughtBy(kind: "components" | "emblems"): { name: string; ids: ItemId[] }[] {
  const seen = new Set<ItemId>();
  return OPENED.map(({ name, cat }) => {
    const ids = cat.ids[kind].filter((id) => !seen.has(id));
    for (const id of ids) seen.add(id);
    return { name, ids };
  }).filter((group) => group.ids.length > 0);
}

/** One entry: the picture at its own size, how a figure holds it, and its name. */
function entry(
  g: Ctx,
  pic: HTMLCanvasElement,
  held: HTMLCanvasElement | null,
  name: string,
  x: number,
  y: number,
): void {
  g.drawImage(pic, x, y);
  if (held) g.drawImage(held, x + 17, y + 4);
  write(g, name, x + 27, y + 3, { px: 1, colour: CREAM });
}
/** A heading over a part of the sheet. */
const heading = (g: Ctx, words: string, x: number, y: number): number =>
  write(g, words, x, y + 2, { px: 1, colour: GOLD[1] });

/** Lays out entries in columns under a heading; gives the height used. */
function block(
  g: Ctx,
  title: string,
  items: readonly (readonly [HTMLCanvasElement, HTMLCanvasElement | null, string])[],
  top: number,
): number {
  heading(g, title, MARGIN, top);
  items.forEach(([pic, held, name], i) => {
    entry(g, pic, held, name, MARGIN + (i % COLUMNS) * ENTRY_W, top + HEAD + Math.floor(i / COLUMNS) * ENTRY_H);
  });
  return HEAD + Math.ceil(items.length / COLUMNS) * ENTRY_H + 4;
}
const asItem = (id: ItemId): readonly [HTMLCanvasElement, HTMLCanvasElement, string] => [
  itemPic(id),
  heldPic(id),
  itemName(NOW, id),
];

/** The sheet at one pixel to an art pixel. */
function paintSheet(): HTMLCanvasElement {
  const comps = broughtBy("components");
  const emblems = broughtBy("emblems");
  const rows = (n: number): number => HEAD + Math.ceil(n / COLUMNS) * ENTRY_H + 4;
  const tall =
    MARGIN * 2 +
    comps.reduce((h, group) => h + rows(group.ids.length), 0) +
    rows(6) +
    rows(FINISHED_IDS.length) +
    rows(2) +
    emblems.reduce((h, group) => h + rows(group.ids.length), 0);
  const { c, g } = makeCanvas(MARGIN * 2 + ENTRY_W * COLUMNS, tall);
  g.fillStyle = INK;
  g.fillRect(0, 0, c.width, c.height);
  let y = MARGIN;
  for (const group of comps) y += block(g, `Components: ${group.name}`, group.ids.map(asItem), y);
  // The same in grey: each must be told apart by its shape alone.
  const all = comps.flatMap((group) => group.ids);
  g.filter = "grayscale(1)";
  y += block(
    g,
    "Components in grey",
    all.map((id) => [itemPic(id), heldPic(id), ""] as const),
    y,
  );
  g.filter = "none";
  y += block(g, "Finished items", FINISHED_IDS.map(asItem), y);
  // A millisecond before Penguin Month's moment, and at it.
  const moment = RELEASES.find((r) => r.id === "penguin-month")?.at ?? 0;
  const before = catalogAt(eraAt(moment - 1));
  const from = catalogAt(eraAt(moment));
  y += block(
    g,
    "Made by a recipe",
    [
      [boonIcon(before, "extrachair"), null, "Before Penguin Month"],
      [boonIcon(from, "extrachair"), null, "From Penguin Month"],
    ],
    y,
  );
  for (const group of emblems) y += block(g, `Emblems: ${group.name}`, group.ids.map(asItem), y);
  return c;
}

/** Shows the sheet in place of the table, `zoom` screen pixels to an art pixel. */
export function showItems(zoom: number): void {
  const pic = paintSheet();
  const z = Math.max(1, Math.round(zoom));
  pic.id = "sheet";
  pic.style.cssText = `position:absolute;left:0;top:0;width:${pic.width * z}px;height:${pic.height * z}px;image-rendering:pixelated;z-index:99;background:${STONE[0]}`;
  document.body.style.background = INK;
  must(document.body, "body").append(pic);
  document.body.style.overflow = "auto";
  document.documentElement.style.overflow = "auto";
}
