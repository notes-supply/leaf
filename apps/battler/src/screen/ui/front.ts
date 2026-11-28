/**
 * The front page, a picker of the ways to play (`modes.ts`): along the top a strip for each run laid
 * out; down the left the categories, and under the chosen one its modes; in the middle the chosen
 * mode's card, with its options and its Set out; on the right its board; along the bottom the
 * almanac, how to play, table looks and leaving. A phone has the same, one under another. Whatever
 * is chosen, the card, the board and the button keep their size and place. In a Discord call it is
 * the call's table alone (`call/`): the live tables' card, the almanac and how to play. The endless ways' own
 * parts (their boards, rooms held, a room taken) are `woods.ts`'s.
 */
import { choices, stepped } from "@sequoia-leaf/kit/choices.ts";
import { el, icon } from "@sequoia-leaf/kit/dom.ts";
import { ask as fetchLeaf } from "@sequoia-leaf/kit/net.ts";
import { type Board as Standings, readBoard } from "@sequoia-leaf/kit/person.ts";
import {
  lastRoom,
  ROOM_COUNT,
  type RunView,
  slotOf,
  summariseRun,
  TRAILS,
  unfought,
  type Way,
  wayWords,
} from "@sequoia-leaf/raid";

import { type Glyph, glyph, roomIcon } from "../art/icons.ts";
import { paintLook } from "../art/place.ts";
import { inCall } from "../call/launch.ts";
import { liveStrip, tablesBody, tablesFoot, tablesRecord } from "../live/tables.ts";
import { snd } from "../sounds.ts";
import { ask, S, type Slot } from "../state.ts";
import { backCard, backUp, showBack, wildsLaid } from "./back.ts";
import { figPic, pic } from "./cards.ts";
import { endlessWhere } from "./endless.ts";
import {
  type At,
  type Board,
  type BoardRow,
  footOf,
  laidOut,
  listed,
  LIVE_TABLES,
  type Mode,
  type ModeId,
  MODES,
  shownCategories,
  shownModes,
  THE_TRAILS,
  trailClosed,
} from "./modes.ts";
import { choosesFigures, setsOutOwn, unshown, wayPrefix, waysOf } from "./own.ts";
import { readNow, readWoods, spanTabs, woodsAt, woodsAway, woodsOpts } from "./woods.ts";

/** What the front page asks of the rest of the page. */
export interface FrontAsks {
  /** Sits down to the run in a slot: the run in hand, or the endless run. */
  carryOn: (slot: Slot) => void;
  /** Sits down to the run in a slot and plays its last fight again. */
  watch: (slot: Slot) => void;
  /** Sets out on a way: a trail or an endless way, with all figures or the member's own. */
  setOut: (way: Way) => void;
  /** Ends the run in a slot early. */
  goHome: (slot: Slot) => void;
  leave: () => void;
  open: (page: "almanac" | "howto" | "looks") => void;
  /** Draws the page again, the keyboard where it was. */
  redraw: () => void;
}

/** How many lines a board lists. */
const BOARD_MOST = 10;
/** Each trail's picture: the kind of room it is hardest in. */
const TRAIL_ICONS = ["trouble", "spar", "boss"] as const;

/**
 * What the page keeps for the session: the mode chosen, a trail not open yet that the member is
 * looking at (of those open, Leaf keeps the one picked), and which run's ending is being asked.
 */
const kept: { mode: ModeId; trail: number | null; home: Slot | null } = { mode: "trails", trail: null, home: null };
/**
 * A page has been opened over it, or it has been put away: ending a run is asked from the start
 * again, a trail not open yet is no longer looked at, and a room taken has been said.
 */
export const frontAway = (): void => {
  kept.home = null;
  kept.trail = null;
  showBack(false);
  woodsAway();
};

/** The guild's raid board as last read: read again when the front page is drawn a minute or more after (`readNow`). */
const guild: { board: Standings | null } = { board: null };
async function readGuild(redraw: () => void): Promise<void> {
  const answer = await fetchLeaf("/v1/game/play/raid/standings");
  const board = answer.status === 200 ? readBoard(answer.body) : null;
  if (!board) return;
  guild.board = board;
  redraw();
}
const atNow = (): At => ({
  run: S.laid.run,
  endless: S.laid.endless,
  almanac: S.almanac,
  trail: kept.trail ?? S.trail,
  own: setsOutOwn(),
  standings: guild.board,
  week: S.week,
  apart: S.apart,
  ...woodsAt(),
  tables: tablesRecord(),
});
// ---------- along the top ----------

/** A button's id for a run: as it is for the run in hand, and with `-endless` for the endless run. */
const idFor = (id: string, slot: Slot): string => (slot === "main" ? id : `${id}-${slot}`);

/** Ending a run before its last room: not before its first room is fought (the rules' `unfought`), and asked first (`strip`). */
function homeOf(go: FrontAsks, run: RunView): HTMLElement {
  if (unfought(run))
    return el("span", "k-read k-dim", { text: "You can end this raid once its first room is fought." });
  const slot = slotOf(run.way);
  return el(
    "button",
    "k-btn coral sm",
    { type: "button", id: idFor("gohome", slot), onclick: () => askHome(go, slot, true) },
    "End this raid",
  );
}

/** Asks whether to end a run, or stops asking: drawn again with the keyboard on End raid, or back on End this raid. */
function askHome(go: FrontAsks, slot: Slot, on: boolean): void {
  kept.home = on ? slot : null;
  go.redraw();
  document.getElementById(idFor(on ? "endraid" : "gohome", slot))?.focus({ preventScroll: true });
}

/**
 * A run laid out, on one line: what it is (its trail, or its endless way: `wayWords`), its room and
 * health, ending it, and carrying on. Ending it is asked in the same place: the question where the
 * run's line is and its two answers where its buttons are, both held there all along, so the row is
 * one height before, while and after it is asked.
 */
function strip(go: FrontAsks, run: RunView): HTMLElement {
  const slot = slotOf(run.way);
  const where =
    lastRoom(run) === Infinity
      ? `${wayPrefix(run)}${endlessWhere(run)}`
      : `${wayPrefix(run)}Room ${run.room + 1} of ${ROOM_COUNT}. Health ${run.resolve}.`;
  const asking = kept.home === slot && !unfought(run);
  // What it is paid for: the rooms won of the fifteen (an endless run's deeper rooms pay nothing).
  const won = summariseRun(run).cleared;
  const askable = !unfought(run);
  const name = wayWords(run.way).name;
  return el(
    "div",
    "k-card lit run",
    {},
    el(
      "div",
      "stack k-grow",
      {},
      el(
        "div",
        "what",
        unshown(!asking),
        // Each on one line, cut where the row is too narrow, and said whole to the pointer.
        el("b", "k-gold", { text: name, title: name }),
        el("span", "k-dim", { text: where, title: where }),
      ),
      askable
        ? el("span", "k-d ask", {
            text: `End this raid now? You are paid for the ${won} ${won === 1 ? "room" : "rooms"} you won.`,
            ...unshown(asking),
          })
        : null,
    ),
    el(
      "div",
      "stack",
      {},
      el(
        "div",
        "k-row acts",
        unshown(!asking),
        homeOf(go, run),
        el(
          "button",
          "k-btn sm",
          { type: "button", id: idFor("carryon", slot), onclick: () => go.carryOn(slot) },
          pic(glyph("play")),
          "Carry on",
        ),
      ),
      askable
        ? el(
            "div",
            "k-row acts",
            unshown(asking),
            el(
              "button",
              "k-btn coral sm",
              { type: "button", id: idFor("endraid", slot), onclick: () => go.goHome(slot) },
              "End raid",
            ),
            el(
              "button",
              "k-btn wood sm",
              { type: "button", id: idFor("keepplaying", slot), onclick: () => askHome(go, slot, false) },
              "Keep playing",
            ),
          )
        : null,
    ),
  );
}

// ---------- down the left ----------

/** Chooses a mode, kept for the session. */
function chooseMode(go: FrontAsks, id: ModeId): void {
  if (id === kept.mode) return;
  kept.mode = id;
  snd.tap();
  go.redraw();
}

/** The categories as tabs (only those with a mode shown), and under the chosen one its modes as cards. */
function picker(go: FrontAsks, shown: readonly Mode[], mode: Mode): HTMLElement {
  const list = el("div", "modes", {});
  const cats = shownCategories(shown);
  const tabs = choices(cats, {
    kind: "tabs",
    name: "Ways to play",
    chosen: mode.category,
    row: "cats",
    page: list,
    choose: (id) => chooseMode(go, shown.find((m) => m.category === id)?.id ?? mode.id),
  });
  cats.forEach((c, i) => tabs.el.children[i]?.prepend(pic(glyph(c.icon), 2)));
  for (const m of shown)
    if (m.category === mode.category)
      list.append(
        el(
          "button",
          "k-card",
          {
            type: "button",
            id: `mode-${m.id}`,
            "aria-pressed": String(m === mode),
            onclick: () => chooseMode(go, m.id),
          },
          el("b", "", { text: m.name }),
        ),
      );
  return el("nav", "picker", { "aria-label": "Ways to play" }, tabs.el, list);
}

// ---------- the chosen mode ----------

/** Chooses a trail: one open is Leaf's to keep (it is the one set out on next, on any page); one not open yet is only looked at. */
async function chooseTrail(go: FrontAsks, trail: number, byKey: boolean): Promise<void> {
  if (trail === atNow().trail) return;
  snd.tap();
  const open = trailClosed(S.almanac, trail) === null;
  kept.trail = open ? null : trail;
  if (open) await ask({ do: "trail", trail }, document.getElementById(`trail-${trail}`));
  go.redraw();
  if (byKey) document.getElementById(`trail-${trail}`)?.focus({ preventScroll: true });
}

/**
 * The three trails, a radio group (one stop for Tab, the arrows choose), and under them what the
 * chosen one is: every trail's words in one place, the others hidden, so choosing moves nothing. A
 * trail not open yet says why under Set out when it is chosen.
 */
function trailsOf(go: FrontAsks, at: At): HTMLElement[] {
  const ids = TRAILS.map((_, i) => String(i));
  const group = el("div", "trails", {
    role: "radiogroup",
    "aria-label": "Trails",
    onkeydown: (e: Event) => {
      const next = "key" in e && typeof e.key === "string" ? stepped(ids, String(at.trail), e.key, "radio") : null;
      if (next === null) return;
      e.preventDefault();
      void chooseTrail(go, Number(next), true);
    },
  });
  TRAILS.forEach((t, i) => {
    const why = trailClosed(at.almanac, i);
    const on = at.trail === i;
    group.append(
      el(
        "button",
        `k-card trail${why ? " done" : ""}${on ? " chosen" : ""}`,
        {
          type: "button",
          id: `trail-${i}`,
          role: "radio",
          "aria-checked": String(on),
          tabindex: on ? 0 : -1,
          "aria-describedby": `trail-is-${i}`,
          onclick: () => void chooseTrail(go, i, false),
        },
        why ? icon("lock") : pic(roomIcon(TRAIL_ICONS[i] ?? "trouble")),
        el("b", "k-grow", { text: t.name }),
        t.pays > 100 ? el("span", "k-dim", { text: `Pays ${t.pays}%` }) : null,
      ),
    );
  });
  const about = TRAILS.map((t, i) => el("p", "k-d", { id: `trail-is-${i}`, text: t.text, ...unshown(i === at.trail) }));
  return [group, el("div", "stack", {}, ...about)];
}

/**
 * Set out, or carry on with the run laid out, the whole width of the card whichever it is; under it,
 * why not, or New raid and what it ends, on a line of one height either way.
 */
function footOfCard(go: FrontAsks, mode: Mode, at: At): HTMLElement {
  const foot = footOf(mode, at);
  const run = mode.run(at);
  const setOut = (): void => {
    const way = mode.setOut?.(at);
    if (way) go.setOut(way);
  };
  const start = (words: string, look: string): HTMLElement =>
    el(
      "button",
      `k-btn ${look}`,
      { type: "button", id: "start", disabled: foot.off, onclick: setOut },
      pic(glyph("swords")),
      words,
    );
  return el(
    "div",
    "mode-foot",
    {},
    el(
      "div",
      "k-row",
      {},
      foot.button === "setOut"
        ? start("Set out", "")
        : el(
            "button",
            "k-btn",
            { type: "button", id: "mode-carry", onclick: () => run && go.carryOn(slotOf(run.way)) },
            pic(glyph("play")),
            "Carry on",
          ),
    ),
    el(
      "div",
      "k-row line",
      {},
      foot.anew ? start("New raid", "wood sm") : null,
      el("p", "k-d", { text: foot.line ?? "" }),
    ),
  );
}

/**
 * A way to set out on's options: whose figures first, in the same place on every card, so going
 * between them moves nothing; then the card's own; then what the figures chosen are, last.
 */
function setOutOpts(go: FrontAsks, mode: Mode, at: At, keep: boolean): (HTMLElement | null)[] {
  const trails = mode.id === "trails";
  const { choice, said } = waysOf(keep, go.redraw, !trails);
  const own = trails
    ? [keep ? el("div", "k-label", { text: "Which way, next time?" }) : null, ...trailsOf(go, at)]
    : woodsOpts(mode, at);
  return [choice, ...own, said];
}

/**
 * The chosen mode: its name, what it is, a picture of the table, its options, and its foot. The
 * words of every mode shown are laid in one place, the others hidden, so the card's head is the
 * same height whichever is chosen and choosing moves nothing (a phone holds only the words of cards
 * like this one, in a card of one height: `other`, raid.css). Like it: every way set out on, whose
 * figures chosen under the head on each, or else Versus alone.
 */
function card(go: FrontAsks, mode: Mode, at: At, shown: readonly Mode[]): HTMLElement {
  const run = mode.run(at);
  // The raid laid out, while it has fought no room, stays the one set out on: what is chosen is for the next.
  const keep = run !== null && unfought(run);
  const options = mode.tables ? tablesBody(go.redraw) : setOutOpts(go, mode, at, keep);
  return el(
    "section",
    "k-card mode",
    { "aria-label": mode.name },
    el(
      "div",
      "mode-head",
      {},
      figPic(paintLook(S.looks)),
      el(
        "div",
        "stack",
        {},
        ...shown.map((m) =>
          el(
            "div",
            m.category === mode.category || (!m.tables && !mode.tables) ? "k-col tight" : "k-col tight other",
            unshown(m === mode),
            el("h2", "k-title big", { text: m.name }),
            el("p", "k-d", { text: m.text }),
          ),
        ),
      ),
    ),
    // A category's own options (`data-category`): another category's are another box, not these moved.
    el("div", "mode-opts k-scroll", { "data-category": mode.category }, ...options),
    mode.tables ? tablesFoot() : footOfCard(go, mode, at),
  );
}

// ---------- on the right ----------

/** A line of a board: its rank, its name and its number; lit for the member's own. */
const boardRow = (r: BoardRow): HTMLElement =>
  el(
    "div",
    r.you ? "k-card lit board-row" : "board-row",
    {},
    el("span", "place", { text: r.place === null ? "" : String(r.place) }),
    el("span", "k-grow", { text: r.name }),
    el("b", "k-gold", { text: r.value }),
  );

/**
 * A board: whose figures it counts, to a member who can choose them (the line held on every board for
 * them, unseen where a board does not count by figures, so its title and rows never move); its
 * title; its rows (the member's own lit) and the member's own under them when it is below them, in a
 * box of their own that scrolls; one with nobody on it says so. Under the rows, `tabs`, the boards to
 * choose between: a board with tabs starts its rows where one without does.
 */
export function boardOf(board: Board, tabs: HTMLElement | null = null): HTMLElement {
  const { top, under } = listed(board, BOARD_MOST);
  const figures = board.figures !== undefined && choosesFigures() ? board.figures : null;
  return el(
    "section",
    "k-card board",
    { "aria-label": figures ? `${board.title}, ${figures.toLowerCase()}` : board.title },
    choosesFigures()
      ? el("div", "k-label figures", { text: figures ?? "All figures", ...unshown(figures !== null) })
      : null,
    el("h2", "k-title", { text: board.title }),
    el(
      "div",
      "board-rows k-scroll",
      {},
      ...top.map(boardRow),
      ...(under ? [el("hr", "k-rule"), boardRow(under)] : []),
      top.length === 0 && !under ? el("p", "k-dim", { text: "Nobody yet." }) : null,
    ),
    tabs,
  );
}

// ---------- the page ----------

function bottom(go: FrontAsks): HTMLElement {
  const to = (page: "almanac" | "howto" | "looks", words: string, sign: Glyph): HTMLElement =>
    el(
      "button",
      "k-btn wood sm",
      { type: "button", id: `to${page}`, onclick: () => go.open(page) },
      pic(glyph(sign)),
      words,
    );
  // In a call: nothing bought with Leaf, and no town to go back to.
  const call = inCall();
  return el(
    "div",
    "k-row menu-foot",
    {},
    to("almanac", "Almanac", "book"),
    to("howto", "How to play", "help"),
    call ? null : to("looks", "Table looks", "brush"),
    call
      ? null
      : el(
          "button",
          "k-btn wood sm",
          { type: "button", id: "leave", onclick: () => go.leave() },
          icon("back"),
          "Leave the table",
        ),
  );
}

/** Carrying on with a run of the Wilds puts its card up first (`back.ts`); any other run sits down. */
const backFirst = (go: FrontAsks): FrontAsks => ({
  ...go,
  carryOn: (slot) => {
    if (slot !== "endless" || wildsLaid() === null) return go.carryOn(slot);
    snd.tap();
    showBack(true);
    go.redraw();
  },
});

/** What the front page's panel holds: the menu, or the card of a run of the Wilds being picked back up. */
export function frontBody(asked: FrontAsks): HTMLElement {
  const wilds = wildsLaid();
  if (backUp() && wilds) return el("div", "k-body menu", {}, backCard(asked, wilds));
  const go = backFirst(asked);
  readNow("guild", () => readGuild(go.redraw));
  const at = atNow();
  const shown = shownModes(inCall() ? [LIVE_TABLES] : MODES);
  const mode = shown.find((m) => m.id === kept.mode) ?? shown[0] ?? THE_TRAILS;
  readWoods(mode, at, go.redraw);
  const runs = inCall() ? [] : laidOut(at);
  const live = liveStrip();
  // The strips, the categories, the card and the board scroll between the title bar and the foot.
  return el(
    "div",
    "k-body menu",
    {},
    el(
      "div",
      "menu-mid k-scroll",
      {},
      runs.length > 0 || live ? el("div", "runs", {}, ...runs.map((r) => strip(go, r.run)), live) : null,
      el(
        "div",
        "menu-cols",
        {},
        picker(go, shown, mode),
        card(go, mode, at, shown),
        boardOf(mode.board(at), spanTabs(mode, at, go.redraw)),
      ),
    ),
    bottom(go),
  );
}
