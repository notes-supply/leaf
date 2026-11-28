/**
 * What the Versus card knows and asks of Leaf, apart from drawing it (`tables.ts` draws it): the
 * tables open to sit at, the member's record, their own sitting followed (its line, `seated.ts`),
 * and opening, sitting down, starting and leaving.
 *
 * The page holds its live connection while the member has a table or the card is up (`heard.ts`).
 * The list is followed (`follow.ts`): one read at a time, asked for when Leaf says it changed, when
 * the soonest of its tables closes, after a table the member was at, as the page comes into the live
 * room, and every `POLL_EVERY` while it is not in it; owed until a read that started after the ask
 * lands, tried again on the kit's timer when one fails, and put off while nobody looks at it (the
 * card down, or a table followed). The first read, which gives a member who sits at a table their
 * sitting back, goes whether or not the card is up, and is owed until Leaf answers it and that sitting
 * is read. Whatever was asked of Leaf before the member took up or let go of a sitting (`T.gen` moves
 * on) is not acted on when it answers: a list read answered after Leave cannot follow the table just
 * left again.
 */
import { ask, isRecord, outside } from "@sequoia-leaf/kit/net.ts";
import type { Scope } from "@sequoia-leaf/kit/scope.ts";

import type { TablesRecord } from "../ui/modes.ts";
import { type Follower, follower, type Went } from "./follow.ts";
import { hearing, hearLive, onHearing, onNudge, POLL_EVERY } from "./heard.ts";
import { AFTER_DEADLINE, type Line, openLine } from "./line.ts";
import { refusalWords } from "./reads.ts";
import { doneWithTable, liveLine, onDone, takeUp } from "./seated.ts";

/** A table open to sit at, as Leaf lists it. */
export interface Listed {
  readonly id: string;
  readonly by: string;
  readonly sat: number;
}

export const T: {
  scope: Scope | null;
  me: { id: string; name: string } | null;
  redraw: () => void;
  open: readonly Listed[] | null;
  record: TablesRecord | null;
  recordAt: number;
  /** Why the last thing asked was not done, said under the buttons. */
  why: string | null;
  /** Leaving a started table is asked first. */
  leaving: boolean;
  asking: boolean;
  /** Moves on whenever the member takes up or lets go of a sitting: an answer asked for before it is not acted on. */
  gen: number;
  /** When the list was last asked for on the timer (or first), and when the soonest of its tables closes (the page's clock). */
  listAt: number;
  closesAt: number | null;
  /** Whether the first read has landed: the member's own sitting, if any, given back. */
  restored: boolean;
  /** Whether the card is up. */
  shown: () => boolean;
  /** Reads the list, one at a time, whenever one is owed. */
  follow: Follower | null;
} = {
  scope: null,
  me: null,
  redraw: () => undefined,
  open: null,
  record: null,
  recordAt: -Infinity,
  why: null,
  leaving: false,
  asking: false,
  gen: 0,
  listAt: -Infinity,
  closesAt: null,
  restored: false,
  shown: () => false,
  follow: null,
};

const RECORD_EVERY = 60_000;
/** How often the page looks at what it holds: the card up or not, a table or not, and the list due. */
const LOOK_EVERY = 1000;

/** In how long the soonest of the listed tables closes, from Leaf's `now`, in milliseconds; null with none. */
function soonestOf(body: { readonly now?: unknown }, open: readonly unknown[]): number | null {
  const now = typeof body.now === "string" ? Date.parse(body.now) : Number.NaN;
  const closes = open.flatMap((t) => (isRecord(t) && typeof t.closes === "string" ? [Date.parse(t.closes)] : []));
  const soonest = Math.min(...closes.filter(Number.isFinite));
  return Number.isFinite(now) && Number.isFinite(soonest) ? soonest - now : null;
}

/** The list Leaf answers, and the member's own sitting. */
function readListed(body: unknown): { open: Listed[]; yours: string | null; closesIn: number | null } | null {
  if (!isRecord(body) || !Array.isArray(body.open)) return null;
  const open = body.open.flatMap((t): Listed[] =>
    isRecord(t) &&
    typeof t.id === "string" &&
    isRecord(t.by) &&
    typeof t.by.name === "string" &&
    typeof t.sat === "number"
      ? [{ id: t.id, by: t.by.name, sat: t.sat }]
      : [],
  );
  return { open, yours: typeof body.yours === "string" ? body.yours : null, closesIn: soonestOf(body, body.open) };
}

/**
 * One read of the list, and the member's own sitting followed when they have one and the page does
 * not. Landed once Leaf answered and their own sitting, if they have one, was read; failed otherwise.
 */
export async function readList(): Promise<Went> {
  const asked = T.gen;
  const answer = await ask("/v1/game/sittings");
  const listed = answer.status === 200 ? readListed(answer.body) : null;
  if (!listed) return "failed";
  // Asked before the member took up or let go of a sitting: old news, and whatever moved it asks again.
  if (asked !== T.gen) return "landed";
  const before = JSON.stringify(T.open);
  T.open = listed.open;
  T.closesAt = listed.closesIn === null ? null : outside.now() + listed.closesIn + AFTER_DEADLINE;
  // Their own table not read (no answer, or trouble) is not done: the read is tried again for it.
  const restored = listed.yours && !liveLine() ? (await follow(listed.yours)) !== null : true;
  if (JSON.stringify(T.open) !== before) T.redraw();
  if (!restored) return "failed";
  T.restored = true;
  return "landed";
}

/** The list's read for its follower: put off while nobody looks at it, once the first has landed. */
const listRead = (): Promise<Went> => (T.restored && !looking() ? Promise.resolve("later") : readList());

async function readRecord(): Promise<void> {
  T.recordAt = Date.now();
  const answer = await ask("/v1/game/sittings/record");
  const b = answer.body;
  if (answer.status !== 200 || !isRecord(b)) return;
  const { played, won, top_four: four } = b;
  if (typeof played !== "number" || typeof won !== "number" || typeof four !== "number") return;
  T.record = { played, won, four };
  T.redraw();
}
/** Reads the member's record again when it is a minute old, or was let go. */
export function recordIfOld(): void {
  if (Date.now() - T.recordAt >= RECORD_EVERY) void readRecord();
}

/** Takes up a sitting from Leaf's answer for it, asked when `T.gen` was `asked`: not if the member took up or let go of one since. */
function lineFrom(id: string, body: unknown, asked: number): Line | null {
  if (asked !== T.gen || !T.scope || !T.me) return null;
  const line = openLine(T.scope, id, T.me.id, body);
  if (!line) return null;
  takeUp(line);
  T.gen++;
  return line;
}

/** Follows the member's own sitting, as Leaf has it: the line to it, and the front page drawn again. */
async function follow(id: string): Promise<Line | null> {
  const asked = T.gen;
  const answer = await ask(`/v1/game/sittings/${id}`);
  const line = answer.status === 200 ? lineFrom(id, answer.body, asked) : null;
  T.redraw();
  return line;
}

/** Asks something of Leaf for the card, one thing at a time, and says why when it was not done. */
async function asking(what: () => Promise<string | null>): Promise<void> {
  if (T.asking) return;
  T.asking = true;
  T.why = null;
  try {
    T.why = await what();
  } finally {
    T.asking = false;
    T.redraw();
  }
}

/**
 * Asks Leaf for a table to sit at (a `POST` of `body` to `path`) and takes it up; or says why not. A
 * table the page follows already (the first read gave it back) is the one asked for: nothing more.
 */
function seatFrom(path: string, body: object): Promise<void> {
  return asking(async () => {
    const asked = T.gen;
    const answer = await ask(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (answer.status === 200 && isRecord(answer.body) && typeof answer.body.id === "string") {
      if (liveLine()?.id === answer.body.id) return null;
      return lineFrom(answer.body.id, answer.body, asked) ? null : "That table could not be read.";
    }
    return isRecord(answer.body) && typeof answer.body.message === "string"
      ? `${answer.body.message}.`
      : "Leaf did not answer. Try again.";
  });
}

/** Opens a table, with the member sat at it. */
export const openTable = (): Promise<void> => seatFrom("/v1/game/sittings", { player: T.me?.id });

/** Sits down at the table of the member's Discord call (`instance`, its launch), opening it if nobody has: Leaf knows which. */
export const joinCall = (instance: string): Promise<void> =>
  seatFrom("/v1/game/sittings/call", { player: T.me?.id, instance });

/** Why the last thing asked of Leaf for the tables was not done, or null. */
export const tablesWhy = (): string | null => T.why;

/** Sits down at an open table. */
export function sitAt(id: string): Promise<void> {
  return asking(async () => {
    const line = await follow(id);
    if (!line) return "That table is gone.";
    const answer = await line.send({ do: "sit" });
    if (!("refused" in answer)) return null;
    doneWithTable();
    return refusalWords(answer.refused, answer.why);
  });
}

/** A command of the member's at their sitting, from the card; `then`, once Leaf has done it. */
export function command(c: { do: "start" } | { do: "leave" }, then: () => void = () => undefined): Promise<void> {
  return asking(async () => {
    const line = liveLine();
    if (!line) return null;
    const answer = await line.send(c);
    if ("refused" in answer) return refusalWords(answer.refused, answer.why);
    then();
    return null;
  });
}

/**
 * Leaves the member's sitting: before it starts the seat is free again, after it they go out. Leaf
 * answering that they have no seat there (they left in another tab) is what was asked: it is let go.
 */
export function leave(): Promise<void> {
  return asking(async () => {
    const line = liveLine();
    if (!line) return null;
    const answer = await line.send({ do: "leave" });
    if ("refused" in answer && answer.refused !== "not_seated") return refusalWords(answer.refused, answer.why);
    doneWithTable();
    return null;
  });
}

/** The member's record at the tables, for the card's board. */
export const tablesRecord = (): TablesRecord | null => T.record;

/** Who the member is and how to draw the card again; and, done with a table, the list again with why. */
export function knowTables(scope: Scope, me: { id: string; name: string }, redraw: () => void): void {
  T.scope = scope;
  T.me = me;
  T.redraw = redraw;
  // Done with a table: the list again, and why when the page says so; a table over has a place in the record, read again.
  onDone((why) => {
    T.gen++;
    T.recordAt = -Infinity;
    T.leaving = false;
    if (why !== null) T.why = why;
    T.redraw();
  });
}

/** Whether the member is looking at the list: the card is up, and they follow no table. */
function looking(): boolean {
  return !liveLine() && T.shown();
}

/**
 * Starts following the live tables: the member's own sitting, if they are at one, and the list while
 * the card is up (`shown`); the live connection is held while either is (`hearLive`). Once a second,
 * while the card is up, the list is asked for when it is `POLL_EVERY` old and the page is not in the
 * live room, or a table on it has closed, and a read put off may go.
 */
export function followTables(
  scope: Scope,
  me: { id: string; name: string },
  redraw: () => void,
  shown: () => boolean,
): void {
  knowTables(scope, me, redraw);
  T.shown = shown;
  T.restored = false;
  const list = follower(scope, listRead);
  T.follow = list;
  followHeard(list);
  T.listAt = outside.now();
  list.want();
  scope.every(LOOK_EVERY, () => {
    hearLive(liveLine() !== null || shown());
    if (!looking()) return;
    const now = outside.now();
    if (!hearing() && now - T.listAt >= POLL_EVERY) {
      T.listAt = now;
      list.want();
    }
    if (T.closesAt !== null && now >= T.closesAt) {
      T.closesAt = null;
      list.want();
    }
    list.kick();
  });
}

/**
 * What the live connection hears, asked for: the member's sitting when Leaf says it moved on, and the
 * list when it says that changed; once the page is in the live room, each once, for what it did not
 * hear before; and the list again once the member is done with a table, which it was not read during.
 */
function followHeard(list: Follower): void {
  onNudge((n) => {
    if (n.t === "sittings") return list.want();
    const line = liveLine();
    if (line?.id === n.id) line.heard(n.rev);
  });
  onHearing((now) => {
    liveLine()?.liveMoved(now);
    if (now) list.want();
  });
  onDone(() => list.want());
}
