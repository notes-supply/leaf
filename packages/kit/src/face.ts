/**
 * What a thing says about itself (`Description`) and how a card draws it: the one look of every card
 * and tip in every game. The deck (`card.ts`) says which card is up, how deep and where; this draws
 * it from the description alone, with the page's hands (`Hands`) for what a drawn thing does.
 *
 * A card is a head (the name, a line under it, a price or stars at its right), its glance (one line:
 * what the thing is or does), and under those its parts: chips, numbers, sections (sentences, a sum,
 * a table, a list of things), blocks, rows of things, and on a pinned card its buttons. A glance is
 * the head and the glance alone, in the small face. Everything a card names is a link: a thing in a
 * row, a chip, a number, a row of a sum and a thing named in a sentence each has its own card.
 */
import { add, asking, asksAgain, el, icon, type Spend } from "./dom.ts";

/** A thing, named as `"kind:id"`: `"item:gear"`, `"figure:barrow-gnome"`, `"trait:ember"`. */
export type Ref = string;

/** A small labelled chip, which may stand for a thing: "Kin", "Gnome 1/2". */
export interface Chip {
  readonly label?: string;
  readonly text: string;
  readonly icon?: Node | null;
  /** A count after the words, as the trait strip shows it: "1/2". */
  readonly count?: string;
  readonly lit?: boolean;
  readonly ref?: Ref;
  /** What it means, in a sentence: its own card, with its words as the name. */
  readonly hint?: string;
}

/** A number with its label; raised (green) or lowered (coral) by something, or lowered by a crack (coral, its edge cracked). */
export interface Stat {
  readonly label: string;
  readonly value: string;
  readonly mark?: "raised" | "lowered" | "cracked";
  /** The thing it is: its card says where the number comes from. */
  readonly ref?: Ref;
  /** What it means, in a sentence, where it has no thing of its own: its own card, with its label as the name. */
  readonly hint?: string;
}

/** A bold title with a note at its right and words under it: an ability, what a machine does. */
export interface Block {
  readonly title?: string;
  readonly note?: string;
  readonly body?: string | Node;
  /** Title, words and note on one line: a trait's steps. */
  readonly line?: boolean;
  /** Picked out: the step a party has reached. */
  readonly lit?: boolean;
}

/** One thing in a row of a card. */
export interface Entry {
  readonly ref: Ref;
  /** Picked out: one the member has, or fields. */
  readonly lit?: boolean;
  /** A small tag: "have", "bench", "stall". */
  readonly tag?: string;
  /** How many: "×2". */
  readonly count?: string;
  /** Something after the name: a price, how many are owed. */
  readonly note?: string | Node;
  /** It is made with this: the line shows that thing's icon, an arrow, then this thing. */
  readonly from?: Ref;
  /** Not to be had yet, and how it opens: shown as a dark outline with these words. */
  readonly locked?: string;
  /** Its own picture or name here, in place of the ones its card has. */
  readonly icon?: Node;
  readonly name?: string;
}

/** A small label and a list of things: "Made from", "Used in", "Every figure". */
export interface Row {
  readonly label: string;
  readonly things: readonly Entry[];
  /** `list` (icon and name, the usual), `icons` (pictures only) or `tiles` (a picture over its name). */
  readonly look?: "list" | "icons" | "tiles";
}

/** A button at the foot of a pinned card. */
export interface Action {
  readonly label?: string;
  readonly icon?: Node | null;
  /** The kit's button classes after `k-btn` (`"wood sm"`, `"coral sm"`), or `"slot"` for a hollow holding an icon. */
  readonly look?: string;
  readonly lit?: boolean;
  readonly off?: boolean;
  /** After the words: what it pays or costs. */
  readonly after?: Node | null;
  /** Its name, where it shows only a picture, with `about` under it: said when it is pointed at. */
  readonly hint?: string;
  readonly about?: string;
  /**
   * For what spends: its price, as `after` shows it, and the words its button says once pressed.
   * The first press only changes the button's words to `again`; a second press does it, while the
   * card stays on show at that price (`Deck.confirms`).
   */
  readonly ask?: { readonly again: string; readonly price: number };
  readonly on: (button: HTMLButtonElement) => void;
}

/** A sentence of a card, and the things it names: each is linked where its name is in the words, and shown after them where it is not. */
export interface Line {
  readonly text: string;
  readonly refs?: readonly Ref[];
}

/** One row of a sum: what adds, how much, and the thing it comes from. */
export interface SumRow {
  readonly label: string;
  readonly value: string;
  readonly ref?: Ref;
}

/** A part of a card under its glance, under a label: sentences, a sum to its total, a table, or a list of things. */
export type Section =
  | { readonly s: "says"; readonly label?: string; readonly lines: readonly Line[] }
  | { readonly s: "sum"; readonly label?: string; readonly rows: readonly SumRow[]; readonly total: string }
  | {
      readonly s: "table";
      readonly label?: string;
      readonly cols: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly s: "things"; readonly label?: string; readonly things: readonly Entry[]; readonly look?: Row["look"] };

/** What a thing says about itself. Only the name is needed. */
export interface Description {
  readonly name: string;
  /** Whether its name is a member's: one word they chose, which may break anywhere; any other name breaks only between words. */
  readonly member?: true;
  /** A canvas (sized to fit by the card) or an element, shown in a slot at the left of the head. */
  readonly icon?: Node | null;
  /** One line under the name: a role, a kind, "worked once". */
  readonly tag?: string | Node;
  /** What it is or does in one line, shown first: all a glance shows besides the head. */
  readonly glance?: string;
  /** What it is in a line, for when it is pointed at inside another card where it has no glance: what an item adds. */
  readonly brief?: string;
  /** At the right of the head: a price, stars. */
  readonly aside?: Node | string | null;
  readonly chips?: readonly Chip[];
  /** Numbers with their labels; a text among them is a heading over the numbers after it, and makes them a sheet. */
  readonly stats?: readonly (Stat | string)[];
  readonly sections?: readonly Section[];
  readonly blocks?: readonly Block[];
  readonly rows?: readonly Row[];
  readonly actions?: readonly Action[];
  /** Part of it is still on its way (a person's numbers, from Leaf): its card is not shown until this settles, and is then asked for again. */
  readonly coming?: Promise<unknown>;
}

/** The parts of a card, in the order it shows them. */
export type Part = "head" | "glance" | "chips" | "stats" | "sections" | "blocks" | "rows" | "actions";

/** The parts past the glance, in their order, and whether a description has each: actions only on a pinned card. */
const PARTS: readonly (readonly [Part, (d: Description, pinned: boolean) => boolean])[] = [
  ["chips", (d) => (d.chips?.length ?? 0) > 0],
  ["stats", (d) => (d.stats?.length ?? 0) > 0],
  ["sections", (d) => (d.sections?.length ?? 0) > 0],
  ["blocks", (d) => (d.blocks?.length ?? 0) > 0],
  ["rows", (d) => d.rows?.some((r) => r.things.length > 0) ?? false],
  ["actions", (d, pinned) => pinned && (d.actions?.length ?? 0) > 0],
];

/** The parts a description makes, in the order a card shows them: a glance only the head and its line; actions only on a pinned card. */
export function partsOf(d: Description, pinned: boolean, glance = false): Part[] {
  const head: Part[] = d.glance ? ["head", "glance"] : ["head"];
  return glance ? head : [...head, ...PARTS.filter(([, has]) => has(d, pinned)).map(([p]) => p)];
}

/** Whether a card shows more than its glance does: a picture, or any part past the glance. Actions count only once pinned. */
export const deep = (d: Description, pinned = false): boolean =>
  Boolean(d.icon) || partsOf(d, pinned).some((p) => p !== "head" && p !== "glance");

/** Words with no thing of their own (a tip's): its name and its line, kept in the reference itself. */
export const SAID = "said";

/** The reference of a name and a line said about something, which describes itself (`saidOf`). */
export const said = (name: string, glance = ""): Ref => `${SAID}:${JSON.stringify([name, glance])}`;

/** What words said (`said`) describe: the name, and the line as its glance. */
export function saidOf(id: string): Description | null {
  try {
    const v: unknown = JSON.parse(id);
    if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "string") return null;
    return v[1] ? { name: v[0], glance: v[1] } : { name: v[0] };
  } catch {
    return null;
  }
}

/** What a drawn card asks of the page. */
export interface Hands {
  describe(ref: Ref): Description | null;
  /** Makes an element stand for a thing: followed inside an open card, its card elsewhere. */
  link(target: HTMLElement, ref: Ref, opts?: { readonly acts?: boolean }): void;
  /** One of the card's buttons was pressed. */
  act(a: Action, button: HTMLButtonElement): void;
  back(): void;
  close(): void;
}

/** How a card is drawn: pinned, as a sheet, only its glance, with a way back, and the thing it is about. */
export interface Face {
  readonly pinned: boolean;
  readonly sheet: boolean;
  readonly glance: boolean;
  readonly back: boolean;
  readonly card: Ref;
}

/** What an action that asks spends on: that action of that card, at its price. */
export const actionSpend = (card: Ref, a: Action): Spend => ({
  on: `${card}|${a.label ?? ""}`,
  price: a.ask?.price ?? 0,
});

/**
 * A canvas's picture fitted into a box `box` units square: by whole steps (at most `most`) where it
 * fits, and shrunk to the box where it does not. One at most `WHOLE` over the box is drawn whole:
 * shrinking it would only drop a row or two of its pixels (the raid's framed items are 14, in 12).
 */
const WHOLE = 2;
function fit(art: Node, box: number, most = 1): Node {
  // One of the kit's own icons grows by its own whole steps.
  if (art instanceof HTMLElement && art.classList.contains("k-i")) {
    art.style.setProperty("--s", String(most));
    return art;
  }
  if (!(art instanceof HTMLCanvasElement)) return art;
  const c = document.createElement("canvas");
  c.width = art.width;
  c.height = art.height;
  c.getContext("2d")?.drawImage(art, 0, 0);
  c.className = "k-px";
  const side = Math.max(art.width, art.height, 1);
  const scale = side > box + WHOLE ? box / side : Math.min(most, Math.max(1, Math.floor(box / side)));
  c.style.width = `calc(var(--u) * ${art.width * scale})`;
  c.style.height = `calc(var(--u) * ${art.height * scale})`;
  return c;
}

const words = (v: string | Node, cls: string): HTMLElement =>
  typeof v === "string" ? el("div", cls, { text: v }) : el("div", cls, {}, v);

/** The class of the line under a card's name: a sentence (it ends with a stop) is read, anything else is in the game's face. */
const tagLook = (v: string | Node): string =>
  /[.?!]$/.test(typeof v === "string" ? v : (v.textContent ?? "")) ? "k-d" : "k-dim";

/** A note after a thing's name, as words or as it was given. */
const noteOf = (note: string | Node | undefined, cls: string): Node | null =>
  note === undefined ? null : typeof note === "string" ? el("span", cls, { text: note }) : note;

/** The small picture of a thing: its icon and name, linked, so every list of things looks and behaves alike. */
export function thingOf(
  h: Hands,
  ref: Ref,
  opts: Omit<Entry, "ref" | "from" | "locked"> & { readonly bare?: boolean } = {},
): HTMLElement {
  const d = h.describe(ref);
  const name = opts.name ?? d?.name ?? ref;
  const art = opts.icon ?? d?.icon ?? null;
  const t = el(
    "span",
    `k-thing${opts.lit ? " lit" : ""}${opts.bare ? " bare" : ""}`,
    opts.bare ? { "aria-label": name } : {},
    art ? el("span", "k-thing-pic", {}, fit(art, 12)) : null,
    opts.bare ? null : el("span", "k-thing-name", { text: name }),
    opts.count ? el("b", "k-thing-count", { text: opts.count }) : null,
    noteOf(opts.note, "k-thing-note k-s k-dim"),
    opts.tag ? el("span", "k-thing-tag k-info-tagged", { text: opts.tag }) : null,
  );
  h.link(t, ref);
  return t;
}

/** What a screen reader calls a chip that is a button: its words and its count as they show, and what it is ("Gnome 1/2, kin"). */
export const chipName = (c: Chip): string =>
  `${c.text}${c.count ? ` ${c.count}` : ""}${c.label ? `, ${c.label.toLowerCase()}` : ""}`;

function chipOf(c: Chip, h: Hands): HTMLElement {
  const face = el(
    "span",
    `k-chip${c.lit ? " lit" : ""}`,
    {},
    c.icon ? fit(c.icon, 12) : null,
    c.text,
    c.count ? el("b", "k-info-count", { text: c.count }) : null,
  );
  const ref = c.ref ?? (c.hint ? said(c.text, c.hint) : null);
  const box = el(
    ref ? "button" : "span",
    "k-info-chip",
    ref ? { type: "button", "aria-label": chipName(c) } : {},
    c.label ? el("span", "k-label", { text: c.label }) : null,
    face,
  );
  if (ref) h.link(box, ref);
  return box;
}

function statOf(s: Stat, h: Hands): HTMLElement {
  const tone = s.mark === "raised" ? "k-leafy" : s.mark === "cracked" ? "k-coral k-cracked" : s.mark ? "k-coral" : "";
  const ref = s.ref ?? (s.hint ? said(s.label, s.hint) : null);
  const box = el(
    ref ? "button" : "span",
    "k-info-stat",
    ref ? { type: "button" } : {},
    el("span", "k-label", { text: s.label }),
    el("b", tone, { text: s.value }),
  );
  if (ref) h.link(box, ref);
  return box;
}

function blockOf(b: Block): HTMLElement {
  const title = b.title ? el("b", "k-info-title", { text: b.title }) : null;
  const note = b.note ? el("span", "k-info-note", { text: b.note }) : null;
  const body = b.body === undefined ? null : words(b.body, "k-read k-info-body");
  if (b.line) return el("div", `k-info-block line${b.lit ? " lit" : ""}`, {}, title, body, note);
  return el(
    "div",
    `k-info-block${b.lit ? " lit" : ""}`,
    {},
    title || note ? el("div", "k-info-bhead", {}, title, note) : null,
    body,
  );
}

function tileOf(e: Entry, h: Hands): HTMLElement {
  const d = e.name !== undefined && e.icon !== undefined ? null : h.describe(e.ref);
  const name = e.name ?? d?.name ?? e.ref;
  const art = e.icon ?? d?.icon ?? null;
  const tile = el(
    "span",
    `k-slot k-info-tile${e.lit ? " lit" : ""}${e.locked ? " locked" : ""}`,
    {},
    el("span", "k-info-tile-pic", {}, art ? fit(art, 24) : null),
    el("span", "k-s k-info-tile-name", { text: name }),
    e.locked ? icon("lock") : noteOf(e.note, "k-s"),
    e.tag ? el("span", "k-info-tagged corner", { text: e.tag }) : null,
  );
  if (!e.locked) h.link(tile, e.ref);
  return tile;
}

function entryOf(e: Entry, look: Row["look"], h: Hands): HTMLElement {
  if (look === "tiles") return tileOf(e, h);
  if (look === "icons") {
    const art = e.icon ?? h.describe(e.ref)?.icon ?? null;
    const s = el("span", `k-slot k-info-icon${e.lit ? " lit" : ""}`, {}, art ? fit(art, 12) : null);
    h.link(s, e.ref);
    return s;
  }
  const t = thingOf(h, e.ref, e);
  if (!e.from) return t;
  const other = h.describe(e.from);
  const pre = el(
    "span",
    "k-info-with",
    { "aria-label": other?.name ?? e.from },
    other?.icon ? fit(other.icon, 12) : null,
  );
  h.link(pre, e.from);
  return el("span", `k-info-make${e.lit ? " lit" : ""}`, {}, pre, el("span", "k-dim k-pix", { text: "→" }), t);
}

/** A label and its things, in a look; and, under tiles, what opens each locked one. */
function rowOf(label: string | undefined, things: readonly Entry[], look: Row["look"], h: Hands): HTMLElement {
  return el(
    "div",
    `k-info-row k-look-${look ?? "list"}`,
    {},
    label ? el("span", "k-label", { text: label }) : null,
    el("div", "k-info-things", {}, ...things.map((e) => entryOf(e, look, h))),
    // What opens each locked one, read at the reading size under the tiles.
    ...things.flatMap((e) =>
      look === "tiles" && e.locked
        ? [
            el(
              "div",
              "k-read k-dim k-info-how",
              {},
              el("b", "", { text: `${e.name ?? h.describe(e.ref)?.name ?? e.ref}: ` }),
              e.locked,
            ),
          ]
        : [],
    ),
  );
}

/** An action's button's classes: a hollow holding its picture, or a button of the kit's. */
const actionLook = (a: Action, ask: string | null): string =>
  a.look === "slot"
    ? `k-slot k-info-pin${a.lit ? " lit" : ""}`
    : `k-btn ${a.look ?? "wood sm"}${a.off ? " off" : ""}${ask ? " asking" : ""}`;

/** What an action's button shows: its picture alone in a hollow, else its picture, words and what it pays or costs. */
const actionFace = (a: Action): (Node | string | null)[] =>
  a.look === "slot" ? [a.icon ? fit(a.icon, 12) : null] : [a.icon ?? null, a.label || null, a.after ?? null];

/**
 * What a screen reader calls an action's button where its face does not say it: a hollow holding a
 * picture (its question while it asks, else its label, else its hint), or a button with nothing but
 * a picture (its hint). A button whose face has words is named by them.
 */
export function actionName(a: Action, ask: string | null): string | null {
  if (a.look === "slot") return ask ?? a.label ?? a.hint ?? null;
  return a.label || a.after ? null : (ask ?? a.hint ?? null);
}

function actionOf(a: Action, card: Ref, h: Hands): HTMLElement {
  const spend = actionSpend(card, a);
  const ask = a.ask !== undefined && asking(spend) ? a.ask.again : null;
  const face = actionFace(a);
  const b: HTMLButtonElement = el(
    "button",
    actionLook(a, ask),
    { type: "button", "aria-label": actionName(a, ask), onclick: () => h.act(a, b) },
    // One that asks shows its question through the kit (`asksAgain`), in a slot as on a button.
    ...(a.ask === undefined ? face : [asksAgain(spend, face, a.ask.again)]),
  );
  // Its name and what it does, said when it is pointed at: it still does its own thing when pressed.
  if (a.hint) h.link(b, said(a.hint, a.about ?? ""), { acts: true });
  return b;
}

/** A letter or a digit: what a name may not touch where it is said whole. */
const WORDLY = /[\p{L}\p{N}]/u;
/** A space and a capital after a name: it is the start of a longer name ("Moth" in "Moth Lantern"). */
const LONGER = /^ \p{Lu}/u;

/** Where a name is said whole in a sentence, clear of what is already taken: -1 where it is not. */
function wholeAt(text: string, name: string, taken: readonly { at: number; end: number }[]): number {
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const end = at + name.length;
    const whole = !WORDLY.test(text[at - 1] ?? "") && !WORDLY.test(text[end] ?? "") && !LONGER.test(text.slice(end));
    if (whole && taken.every((t) => end <= t.at || at >= t.end)) return at;
  }
  return -1;
}

/**
 * The words of a sentence and the things in them, in the sentence's order: each thing where its name
 * is said whole (not inside a longer word or a longer name), a longer name first where two share
 * words; and, in their own order, the things it names but does not say.
 */
export function namedIn(
  text: string,
  named: readonly { readonly ref: Ref; readonly name: string }[],
): {
  readonly parts: readonly (string | { readonly ref: Ref; readonly text: string })[];
  readonly after: readonly Ref[];
} {
  const taken: { at: number; end: number; ref: Ref }[] = [];
  const found = new Set<number>();
  const longestFirst = named.map((n, i) => ({ ...n, i })).toSorted((a, b) => b.name.length - a.name.length);
  for (const n of longestFirst) {
    const at = n.name ? wholeAt(text, n.name, taken) : -1;
    if (at < 0) continue;
    taken.push({ at, end: at + n.name.length, ref: n.ref });
    found.add(n.i);
  }
  const parts: (string | { ref: Ref; text: string })[] = [];
  const end = taken
    .toSorted((a, b) => a.at - b.at)
    .reduce((from, t) => {
      parts.push(text.slice(from, t.at), { ref: t.ref, text: text.slice(t.at, t.end) });
      return t.end;
    }, 0);
  parts.push(text.slice(end));
  return { parts: parts.filter((p) => p !== ""), after: named.filter((_, i) => !found.has(i)).map((n) => n.ref) };
}

/** A sentence with each thing it names linked where its name is said, and the things it names but does not say after it. */
function lineOf(l: Line, h: Hands): HTMLElement {
  const named = (l.refs ?? []).map((ref) => ({ ref, name: h.describe(ref)?.name ?? "" }));
  const { parts, after } = namedIn(l.text, named);
  const drawn = parts.map((p) => {
    if (typeof p === "string") return p;
    const link = el("span", "k-named", { text: p.text });
    h.link(link, p.ref);
    return link;
  });
  return el("p", "k-read k-info-line", {}, ...drawn, ...after.map((r) => thingOf(h, r)));
}

/** A table's lines (its headings, then its rows), each as wide as the widest: a short one gets empty cells, so every value stays under its heading. */
export function tableLines(cols: readonly string[], rows: readonly (readonly string[])[]): string[][] {
  const n = Math.max(1, cols.length, ...rows.map((r) => r.length));
  return [cols, ...rows].map((r) => Array.from({ length: n }, (_, i) => r[i] ?? ""));
}

/** A line of a table: headings, or a row; the first cell its label, at the left. */
const tableRow = (cells: readonly string[], heads: boolean): HTMLElement =>
  el(
    "div",
    "k-info-trow",
    { role: "row" },
    ...cells.map((c, j) =>
      el("span", `${heads ? "k-label" : ""}${j === 0 ? " first" : ""}`.trim(), {
        role: heads ? "columnheader" : "cell",
        text: c,
      }),
    ),
  );

/** A sum's row: what adds (linked to where it comes from) and how much. */
function sumRowOf(r: SumRow, h: Hands): HTMLElement {
  const label = el("span", r.ref ? "k-named" : "", { text: r.label });
  if (r.ref) h.link(label, r.ref);
  return el("div", "k-info-sum-row", {}, label, el("b", "", { text: r.value }));
}

function sectionOf(s: Section, h: Hands): HTMLElement {
  const label = s.label ? el("span", "k-label", { text: s.label }) : null;
  switch (s.s) {
    case "says":
      return el("div", "k-info-sec says", {}, label, ...s.lines.map((l) => lineOf(l, h)));
    case "sum":
      return el(
        "div",
        "k-info-sec sum",
        {},
        label,
        ...s.rows.map((r) => sumRowOf(r, h)),
        el("div", "k-info-sum-row total", {}, el("span", ""), el("b", "", { text: s.total })),
      );
    case "table": {
      // A row a line: the first column its label, at the left; the numbers after it, at the right.
      const [heads = [], ...rows] = tableLines(s.cols, s.rows);
      const grid = el("div", "k-info-table", { role: "table", "aria-label": s.label ?? null }, tableRow(heads, true));
      add(grid, ...rows.map((r) => tableRow(r, false)));
      const n = heads.length;
      grid.style.gridTemplateColumns = n > 1 ? `minmax(0, 1fr) repeat(${n - 1}, auto)` : "minmax(0, 1fr)";
      return el("div", "k-info-sec", {}, label, grid);
    }
    case "things":
      return rowOf(s.label, s.things, s.look, h);
  }
}

/** A card's head: a way back, its picture, its name and the line under it, what is at its right, and its close button. */
function headOf(d: Description, f: Face, small: boolean, h: Hands): HTMLElement {
  const back = f.back
    ? el(
        "button",
        "k-btn icon plum sm k-info-back",
        { type: "button", "aria-label": "Back", onclick: () => h.back() },
        icon("back"),
      )
    : null;
  // A passing card keeps the close button's room, unseen, so that pinning it moves nothing: a name
  // that fitted two lines beside no button would take three beside one. A glance has no such room.
  const x = f.pinned
    ? el(
        "button",
        "k-btn wood icon sm k-info-x",
        { type: "button", "aria-label": "Close", onclick: () => h.close() },
        icon("close"),
      )
    : small
      ? null
      : el("span", "k-btn wood icon sm k-info-x unseen", { "aria-hidden": "true" }, icon("close"));
  return el(
    "div",
    "k-info-head",
    {},
    back,
    d.icon && !small ? el("span", "k-slot k-info-pic", {}, fit(d.icon, 40, 2)) : null,
    // The name and what is at its right share a row that the latter leaves first, onto a line of its own.
    el(
      "div",
      "k-info-main",
      {},
      el(
        "div",
        "k-info-who",
        {},
        d.name ? el("b", d.member ? "k-name member" : "k-name", { text: d.name }) : null,
        d.tag === undefined ? null : words(d.tag, `${tagLook(d.tag)} k-info-tag`),
      ),
      d.aside ? el("span", "k-info-aside", {}, d.aside) : null,
    ),
    x,
  );
}

/** A card's numbers: under headings, a sheet of a line each. */
function statsOf(stats: readonly (Stat | string)[], h: Hands): HTMLElement {
  const listed = stats.some((s) => typeof s === "string");
  return el(
    "div",
    `k-info-part k-info-stats${listed ? " listed" : ""}`,
    {},
    ...stats.map((s) => (typeof s === "string" ? el("span", "k-label k-info-over", { text: s }) : statOf(s, h))),
  );
}

/** One part of a card, drawn. */
function partOf(part: Exclude<Part, "head">, d: Description, f: Face, h: Hands): HTMLElement {
  switch (part) {
    case "glance":
      return el("p", "k-read k-info-glance", { text: d.glance ?? "" });
    case "chips":
      return el("div", "k-info-part k-info-chips", {}, ...(d.chips ?? []).map((c) => chipOf(c, h)));
    case "stats":
      return statsOf(d.stats ?? [], h);
    case "sections":
      return el("div", "k-info-part k-info-secs", {}, ...(d.sections ?? []).map((s) => sectionOf(s, h)));
    case "blocks":
      return el("div", "k-info-part k-info-blocks", {}, ...(d.blocks ?? []).map(blockOf));
    case "rows":
      return el(
        "div",
        "k-info-part k-info-rows",
        {},
        ...(d.rows ?? []).filter((r) => r.things.length > 0).map((r) => rowOf(r.label, r.things, r.look, h)),
      );
    case "actions":
      return el("div", "k-info-part k-info-acts", {}, ...(d.actions ?? []).map((a) => actionOf(a, f.card, h)));
  }
}

/**
 * A card, drawn from its description. Only its glance, or a description that has nothing more, is
 * drawn small: as wide as its words, its name in the name's face, no picture.
 */
export function drawCard(d: Description, f: Face, h: Hands): HTMLElement {
  const small = f.glance || !deep(d, f.pinned);
  const card = el(
    "div",
    `k-tip k-float k-info${f.pinned ? " pinned" : ""}${f.sheet ? " sheet" : ""}${small ? " glance" : ""}`,
    { role: f.pinned ? "dialog" : "tooltip", "aria-label": d.name || null, tabindex: f.pinned ? -1 : null },
  );
  for (const part of partsOf(d, f.pinned, f.glance)) {
    if (part === "head") {
      if (d.name || d.tag !== undefined || f.pinned || f.back) add(card, headOf(d, f, small, h));
    } else add(card, partOf(part, d, f, h));
  }
  return card;
}
