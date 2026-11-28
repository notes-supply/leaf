/**
 * The live tables on the raid's front page, in its Versus category, as the page draws them (what
 * the card knows and asks of Leaf is `listing.ts`): the tables open to sit at (who opened each, how
 * many sat), Open a table and Sit down; once sat, the table's eight seats until it starts, with
 * Start for whoever opened it and Leave for anyone; once started, Carry on (and the strip along the
 * top, as a run in hand has); once over, how it ended. The member's record at the tables is the
 * card's board (`tablesBoard` in `modes.ts`). In a Discord call the card is the call's table alone
 * (`call/`): no list of tables, Join the table in place of Open a table, and Next table once it is over.
 */
import { el, icon } from "@sequoia-leaf/kit/dom.ts";
import type { Scope } from "@sequoia-leaf/kit/scope.ts";
import { CHAIRS } from "@sequoia-leaf/raid/sitting/sitting.ts";
import type { SittingView } from "@sequoia-leaf/raid/sitting/view.ts";

import { glyph } from "../art/icons.ts";
import { LAUNCH, type Launch } from "../call/launch.ts";
import { snd } from "../sounds.ts";
import { pic } from "../ui/cards.ts";
import { command, followTables, joinCall, leave, openTable, recordIfOld, sitAt, T } from "./listing.ts";
import { placeText } from "./reads.ts";
import { enterTable } from "./seat.ts";
import { doneWithTable, liveView } from "./seated.ts";

export { tablesRecord } from "./listing.ts";

/** A press on the card: a tap, and the thing done (what asks Leaf goes one at a time). */
const pressed =
  (act: () => unknown): (() => void) =>
  () => {
    snd.tap();
    void act();
  };

const mineOf = (view: SittingView) => (view.you === null ? null : (view.seats[view.you] ?? null));
const inCount = (view: SittingView): number => view.seats.filter((s) => s.place === null).length;

// ---------- the card ----------

/** The eight seats of a table not started: who sat, in order, and the rest for regulars. */
function seatsOf(view: Extract<SittingView["stage"], { at: "open" }>, by: string): HTMLElement {
  const rows = Array.from({ length: CHAIRS }, (_, i) => {
    const m = view.sat[i];
    return el(
      "div",
      m?.id === T.me?.id ? "k-card lit board-row" : "board-row",
      {},
      el("span", "place", { text: String(i + 1) }),
      m ? el("span", "k-grow", { text: m.name }) : el("span", "k-grow k-dim", { text: "A regular will sit here" }),
      m?.id === by ? el("span", "k-dim", { text: "Opened it" }) : null,
    );
  });
  return el("div", "k-col tight live-seats", { id: "live-seats" }, ...rows);
}

/** The tables open to sit at, each with Sit down. */
function openList(): HTMLElement[] {
  if (T.open === null) return [el("p", "k-d k-dim", { text: "Looking for tables." })];
  if (T.open.length === 0)
    return [
      el("p", "k-d", { text: "No tables are open. Open one: others can sit down, and you start it when you like." }),
    ];
  return [
    el("div", "k-label", { text: "Open tables" }),
    el(
      "div",
      "k-col tight live-list",
      {},
      ...T.open.map((t) =>
        el(
          "div",
          "board-row",
          {},
          el("span", "k-grow", { text: `${t.by}'s table` }),
          el("span", "k-dim", { text: `${t.sat} of ${CHAIRS} seated` }),
          el(
            "button",
            "k-btn sm",
            { type: "button", "data-table": t.id, disabled: T.asking, onclick: pressed(() => sitAt(t.id)) },
            "Sit down",
          ),
        ),
      ),
    ),
  ];
}

/** In a call with no table: Leaf being asked for it, or no table yet (why is said under the button). */
const callWaits = (): HTMLElement[] => [
  el("p", "k-d", { text: T.asking ? "Finding this call's table." : "No table yet." }),
];

/** What the card holds: the open tables (or in a call, its table), the member's table before it starts, or how it stands. */
export function tablesBody(redraw: () => void): HTMLElement[] {
  T.redraw = redraw;
  recordIfOld();
  const view = liveView();
  if (!view) return [el("div", "k-col", { id: "live-tables" }, ...(LAUNCH ? callWaits() : openList()))];
  const mine = mineOf(view);
  if (view.stage.at === "open")
    return [el("div", "k-label", { id: "live-tables", text: "Your table" }), seatsOf(view.stage, view.by)];
  const where =
    view.stage.at === "over"
      ? `Your table is over${mine?.place ? `: ${placeText(mine.place)}` : ""}.`
      : mine?.place
        ? `You are out of your table: ${placeText(mine.place)}. ${inCount(view)} of ${CHAIRS} still in.`
        : `Your table is on: room ${view.room + 1}, health ${mine?.resolve ?? 0}. ${inCount(view)} of ${CHAIRS} still in.`;
  return [el("p", "k-d", { id: "live-tables", text: where })];
}

const button = (id: string, words: string, act: () => unknown, look = "", sign: HTMLElement | null = null) =>
  el("button", `k-btn ${look}`.trim(), { type: "button", id, disabled: T.asking, onclick: pressed(act) }, sign, words);

/** The buttons of a table started: Carry on, and leaving it (asked first: it is going out). */
function startedFoot(view: SittingView): HTMLElement[] {
  if (T.leaving)
    return [
      button("live-leave-yes", "Leave", leave, "coral"),
      button(
        "live-leave-no",
        "Stay",
        () => {
          T.leaving = false;
          T.redraw();
        },
        "wood",
      ),
    ];
  const out = mineOf(view)?.place != null;
  return [
    out
      ? null
      : button(
          "live-quit",
          "Leave",
          () => {
            T.leaving = true;
            T.redraw();
          },
          "wood",
        ),
    button("live-carry", "Carry on", enterTable, "", pic(glyph("play"))),
  ].filter((b) => b !== null);
}

/** The call's next table, once the last is over: its line let go, and the call's table asked for again. */
function nextTable(call: Launch): Promise<void> {
  doneWithTable();
  return joinCall(call.instance);
}

/** The card's foot: its buttons, and the line under them. */
export function tablesFoot(): HTMLElement {
  const view = liveView();
  const call = LAUNCH;
  let buttons: HTMLElement[];
  let line: string;
  if (!view) {
    buttons = [
      call
        ? button("live-join", "Join the table", () => joinCall(call.instance), "", pic(glyph("swords")))
        : button("live-open", "Open a table", openTable, "", pic(glyph("swords"))),
    ];
    line = "";
  } else if (view.stage.at === "open") {
    const opener = view.by === T.me?.id;
    const empty = CHAIRS - view.stage.sat.length;
    buttons = [
      button("live-leave", "Leave", leave, "wood", icon("back")),
      opener ? button("live-start", "Start", () => command({ do: "start" }), "", pic(glyph("swords"))) : null,
    ].filter((b) => b !== null);
    const who = view.stage.sat.find((m) => m.id === view.by)?.name ?? "whoever opened it";
    line = opener
      ? `Start now, and regulars take the ${empty} empty seat${empty === 1 ? "" : "s"}.`
      : `Waiting for ${who} to start. A full table starts by itself.`;
  } else if (view.stage.at === "over") {
    buttons = [
      button("live-end", "See how it ended", enterTable, call ? "wood" : "", pic(glyph("play"))),
      call ? button("live-next", "Next table", () => nextTable(call), "", pic(glyph("swords"))) : null,
    ].filter((b) => b !== null);
    line = "";
  } else {
    buttons = startedFoot(view);
    line = T.leaving ? "Leave? You go out, in the last place of those still in." : "";
  }
  return el("div", "mode-foot", {}, el("div", "k-row", {}, ...buttons), el("p", "k-d", { text: T.why ?? line }));
}

/** The strip along the top for the member's live table, started and not over, as a run in hand has one. */
export function liveStrip(): HTMLElement | null {
  const view = liveView();
  const mine = view ? mineOf(view) : null;
  if (!view || !mine || view.stage.at === "open" || view.stage.at === "over" || mine.place !== null) return null;
  return el(
    "div",
    "k-card lit run",
    {},
    // One line, as the runs' strips above it are: its name and where it stands, beside Carry on.
    el(
      "div",
      "what k-grow",
      {},
      el("b", "k-gold", { text: "Live table" }),
      el("span", "k-dim", {
        text: `Room ${view.room + 1}. Health ${mine.resolve}. ${inCount(view)} of ${CHAIRS} still in.`,
      }),
    ),
    el("div", "k-row acts", {}, button("live-strip-carry", "Carry on", enterTable, "sm", pic(glyph("play")))),
  );
}

/** Starts following the live tables: the member's own sitting, if they are at one, and the list while the card is up. */
export function openTables(scope: Scope, me: { id: string; name: string }, redraw: () => void): void {
  followTables(scope, me, redraw, () => document.getElementById("live-tables")?.isConnected === true);
}
