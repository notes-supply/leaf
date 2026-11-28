/**
 * The raid in a Discord call, as Discord's small picture of it (when the player looks elsewhere in
 * Discord, around 400 by 225 and under): the table's state in one line, and nothing to press. The
 * page keeps the line up to date while it is in a call; its styles show it, and only it, at that size
 * (`live.css`).
 */
import { el } from "@sequoia-leaf/kit/dom.ts";
import { outside } from "@sequoia-leaf/kit/net.ts";
import type { Scope } from "@sequoia-leaf/kit/scope.ts";
import { ROOM_COUNT } from "@sequoia-leaf/raid";
import { CHAIRS } from "@sequoia-leaf/raid/sitting/sitting.ts";
import type { SittingView } from "@sequoia-leaf/raid/sitting/view.ts";

import { tablesWhy } from "../live/listing.ts";
import { clockText, placeText } from "../live/reads.ts";
import { liveLine, liveView } from "../live/seated.ts";

/** How often the line is drawn again: its seconds count down. */
const EVERY_MS = 1000;

/**
 * The table in one line: who has sat before it starts, the room and the stage's seconds while it
 * goes, the member's place once it is over; with no table, why not (`why`), or that it is being found.
 */
export function callLine(view: SittingView | null, now: number, why: string | null): string {
  if (view === null) return why ?? "Finding this call's table";
  const { stage } = view;
  if (stage.at === "open") return `${clockText(view, now)} · ${stage.sat.length} of ${CHAIRS} seated`;
  const place = view.you === null ? null : (view.seats[view.you]?.place ?? null);
  if (stage.at === "over")
    return place === null ? clockText(view, now) : `${clockText(view, now)} · ${placeText(place)}`;
  const room = view.room < ROOM_COUNT ? `Room ${view.room + 1} of ${ROOM_COUNT}` : `Room ${view.room + 1}`;
  return `${room} · ${clockText(view, now)}`;
}

/** Puts the line on the page, kept up to date by Leaf's clock while `scope` lasts. */
export function openCallLine(scope: Scope): void {
  const line = el("p", "call-line", { id: "call-line" });
  document.body.append(line);
  document.body.dataset.call = "";
  const draw = (): void => {
    line.textContent = callLine(liveView(), liveLine()?.now() ?? outside.now(), tablesWhy());
  };
  draw();
  scope.every(EVERY_MS, draw);
}
