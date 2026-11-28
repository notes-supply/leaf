/**
 * The rack on the page: a tile per kind (`stacks.ts`), the components in their own row, always all of
 * them; under it the rest in a box of fixed size that scrolls in itself, so the rack never grows
 * however much is on it, and nothing round it moves. Then the boons held.
 */
import { link } from "@sequoia-leaf/kit/card.ts";
import { el } from "@sequoia-leaf/kit/dom.ts";
import { boonIn, catalogOf, kindsOn, rackName, type RunView } from "@sequoia-leaf/raid";

import { boonIcon, itemIcon } from "../art/icons.ts";
import { countWord, type Stack, stacksOf } from "../stacks.ts";
import { boonRef, itemRef, pic } from "./cards.ts";
import { rackDrawn } from "./drawn.ts";

/** What the rack was last drawn from (`rackDrawn`): it is drawn again only when that changes. */
const DRAWN = { key: "" };
/** Forgets what the rack was drawn from, so that it is drawn afresh: for a new run. */
export function forgetRack(): void {
  DRAWN.key = "";
}

/**
 * One tile of the rack: a kind, with how many there are when more than one. Tapping it picks one up
 * to give it, a finger kept on it asks what it is, and its card goes beside the rack. A component
 * there is none of is a dim, empty tile that does nothing.
 */
function rackTile(run: RunView, tile: Stack): HTMLElement {
  // Its kind on it, filled or empty: the same tile, whether there is any of it or none.
  if (tile.count === 0) return el("span", "k-slot item none", { "data-kind": tile.item }, pic(itemIcon(tile.item)));
  const name = rackName(catalogOf(run), tile.item);
  const slot = el(
    "button",
    "k-slot item",
    {
      type: "button",
      "data-item": tile.item,
      "data-kind": tile.item,
      "aria-label": tile.count > 1 ? `${name}, ${tile.count}` : name,
    },
    pic(itemIcon(tile.item)),
    tile.count > 1 ? el("b", "n", { text: countWord(tile.count) }) : null,
  );
  link(slot, itemRef(tile.item, true), { acts: true, side: true });
  return slot;
}

/**
 * The rack: a tile per kind (`stacks.ts`), the components in their own row, always all of them;
 * under it the rest in a box of fixed size that scrolls in itself, so the rack never grows however
 * much is on it, and nothing round it moves. Then the boons held.
 */
export function renderRack(run: RunView): void {
  const rack = document.getElementById("rack");
  if (!rack) return;
  const key = rackDrawn(run);
  if (key === DRAWN.key) return;
  DRAWN.key = key;
  // Drawn again, the box keeps where it was scrolled to.
  const scrolled = rack.querySelector(".made")?.scrollTop ?? 0;
  rack.replaceChildren();
  // With nothing on it, a wide window's rack is not shown (a phone's keeps its place: `raid.css`).
  rack.classList.toggle("empty", kindsOn(run.rack).length === 0 && run.boons.length === 0);
  const { parts, rest } = stacksOf(run);
  const made = el("div", "made", {}, ...rest.map((tile) => rackTile(run, tile)));
  rack.append(el("div", "k-plaque items", {}, el("div", "parts", {}, ...parts.map((t) => rackTile(run, t))), made));
  made.scrollTop = scrolled;
  if (run.boons.length > 0) {
    const boons = el("div", "k-plaque boons", {});
    for (const boon of run.boons) {
      const { name } = boonIn(catalogOf(run), boon);
      const slot = el(
        "button",
        "k-slot boon",
        { type: "button", "aria-label": name },
        pic(boonIcon(catalogOf(run), boon)),
      );
      link(slot, boonRef(boon));
      boons.append(slot);
    }
    rack.append(boons);
  }
}
