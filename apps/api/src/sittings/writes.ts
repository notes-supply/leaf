/**
 * Keeping a sitting: one transaction that checks the `rev` it was read at and writes it, with
 * everything that follows from it: the Coins its members are owed, paid once within what each may
 * still earn; seats taken and freed; the place of each member it puts out, or first; what it logs;
 * and the answers to the commands that changed it. What is stored having moved on, or a seat taken meanwhile at another
 * sitting, it fails `Lost` and writes nothing, and the job is done again from what is stored.
 */
import { type Logged, parsePlayerId } from "@sequoia-leaf/core";
import { roomsFought } from "@sequoia-leaf/raid/record.ts";
import { paidOff } from "@sequoia-leaf/raid/sitting/commands.ts";
import { encodeSitting } from "@sequoia-leaf/raid/sitting/keep.ts";
import { CHAIRS, type Owed, type Sitting } from "@sequoia-leaf/raid/sitting/sitting.ts";
import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql";

import { Coins } from "../play/coins.ts";
import { PlayStore } from "../play/store.ts";
import { type Place, type SittingStore, sittingStore, type Writing } from "./store.ts";
import { sittingsTold } from "./told.ts";

/** What is stored moved on while a job worked from what it read: another job wrote it, or a seat was taken elsewhere. */
export class Lost extends Data.TaggedError("Lost") {}
/** As many sittings are not over as may be (`MOST_NOT_OVER`): a new one is not kept. */
export class Full extends Data.TaggedError("Full") {}
/** The launch in a Discord call a new sitting was for has one not over, made meanwhile: the new one is not kept. */
export class Taken extends Data.TaggedError("Taken") {}

/** How many sittings may be not over at once; opening one past it is refused. */
export const MOST_NOT_OVER = 500;

/** The game a sitting's Coins and logs are of. */
export const GAME = "raid";
/** Where the answers to the commands at sittings are kept, among the play service's (`play_commands`). */
export const ANSWERS = "sittings";
/** What a Coins entry paid for a seat says. */
const PAID_FOR = "The Little Raid, at a table";

/** What the sittings log, in `activity` under the raid: a sitting opened, started and ended, under whoever opened it. */
export const LOGGED_SITTING = {
  opened: "raid_table_opened",
  started: "raid_table_started",
  ended: "raid_table_ended",
} as const;

/** A sitting as a job read it: the `rev` and text stored, and the sitting the text is. */
export interface Loaded {
  readonly rev: number;
  readonly text: string;
  readonly sitting: Sitting;
}

/** A command's answer as kept: what happened, or the refusal's code and sentence. */
export type Answer = { readonly notes: readonly unknown[] } | { readonly refused: string; readonly why: string };

/** The commands of one player's a write keeps the answers to. */
export interface Asked {
  readonly player: string;
  readonly answers: readonly { readonly id: string; readonly answer: Answer }[];
}

const isMember = (seat: Sitting["seats"][number]) => seat.who.is === "member";
const memberId = (seat: Sitting["seats"][number]): string[] => (seat.who.is === "member" ? [seat.who.id] : []);
const started = (t: Sitting): boolean => t.seats.length > 0;
const isOver = (t: Sitting | null): boolean => t?.stage.at === "over";

/** Who is to be seated at a sitting: everyone sat at an open one, each member still in at a started one, nobody once over. */
export function seatedAt(t: Sitting): string[] {
  const { stage } = t;
  if (stage.at === "open") return stage.sat.map((m) => m.id);
  if (stage.at === "over") return [];
  return t.seats.filter((seat) => seat.place === null).flatMap(memberId);
}

/** A sitting as it is written: its text, where it stands, and when it is due next or ended. */
export function writingOf(t: Sitting, state: string): Writing {
  const { stage } = t;
  return stage.at === "over"
    ? { state, stage: stage.at, dueAt: null, endedAt: stage.ended }
    : { state, stage: stage.at, dueAt: stage.until, endedAt: null };
}

/** Each member's place at a sitting, of those who have one: out, or the sitting over. */
const placesAt = (t: Sitting): Place[] =>
  t.seats.flatMap((seat) =>
    seat.who.is === "member" && seat.place !== null ? [{ player: seat.who.id, place: seat.place }] : [],
  );

/**
 * The places a write settles: each member with a place after it and none before. The order of going
 * out decides a place, so it is known as a member goes out; the last one in is first, at the end.
 */
export function placesOf(before: Sitting | null, after: Sitting): Place[] {
  const had = new Set((before === null ? [] : placesAt(before)).map((p) => p.player));
  return placesAt(after).filter((p) => !had.has(p.player));
}

/** How many rooms a sitting fought: as many as the seat that fought the most. */
const roomsOf = (t: Sitting): number => Math.max(0, ...t.seats.map((seat) => roomsFought(seat.run)));

/** What a write logs, from how the sitting stood before it (null: a new one) to after it. */
export function loggedOf(id: string, before: Sitting | null, after: Sitting): Logged[] {
  const logged: Logged[] = [];
  if (before === null) logged.push({ kind: LOGGED_SITTING.opened, data: { sitting: id } });
  if (!(before !== null && started(before)) && started(after)) {
    const members = after.seats.filter(isMember).length;
    logged.push({ kind: LOGGED_SITTING.started, data: { sitting: id, members } });
  }
  if (!isOver(before) && isOver(after) && started(after)) {
    const places = placesAt(after);
    logged.push({ kind: LOGGED_SITTING.ended, data: { sitting: id, rooms: roomsOf(after), places } });
  }
  return logged;
}

/** What follows from a sitting written, and the answers kept with it, on the Coins, the play service's store and the sittings'. */
function followsIn(coins: Coins["Service"], playStore: PlayStore["Service"], store: SittingStore) {
  /**
   * Pays what a sitting owes, each once under the sitting's id and the seat, cut to what its member
   * may still earn now, as a solo run's is (the rest is not paid at all). A member's Coins open with
   * the welcome first, if they have none yet.
   */
  const pay = (id: string, owed: readonly Owed[], now: number) =>
    Effect.forEach(
      owed,
      (o) =>
        Effect.gen(function* () {
          const member = parsePlayerId(o.member);
          if (member === undefined) return yield* Effect.die(new Error(`A sitting owed Coins to ${o.member}`));
          yield* coins.open(member, now);
          const amount = Math.min(o.coins, yield* coins.room(member, now));
          if (amount > 0)
            yield* coins.post(member, { amount, reason: PAID_FOR, game: GAME, key: `sitting:${id}:${o.key}` }, now);
        }),
      { discard: true },
    );

  /** Seats whoever is to be seated (`seatedAt`) and frees the rest; one seated at another sitting meanwhile fails `Lost`. */
  const seatAll = (id: string, t: Sitting, now: number) =>
    Effect.gen(function* () {
      const wanted = seatedAt(t);
      const held = yield* store.seatsAt(id);
      yield* store.unseat(
        id,
        held.filter((player) => !wanted.includes(player)),
      );
      for (const player of wanted.filter((p) => !held.includes(p))) {
        if (!(yield* store.seat(player, id, now))) return yield* new Lost();
      }
    });

  return {
    /**
     * Everything that follows from a sitting written: Coins paid, seats, places and logs. A place is
     * kept as of the write that settles it, or of the sitting's end.
     */
    follow: (id: string, before: Sitting | null, after: Sitting, owed: readonly Owed[], now: number) =>
      Effect.gen(function* () {
        yield* pay(id, owed, now);
        yield* seatAll(id, after, now);
        const places = placesOf(before, after);
        const at = after.stage.at === "over" ? after.stage.ended : now;
        if (places.length > 0) yield* store.place(id, places, CHAIRS, at);
        const logged = loggedOf(id, before, after);
        const by = parsePlayerId(after.by);
        if (by === undefined) return yield* Effect.die(new Error(`A sitting opened by ${after.by}`));
        if (logged.length > 0) yield* playStore.log(by, GAME, logged, now);
      }),
    /** Keeps the answers to a player's commands, at the `rev` they led to, and counts them for the staff's report. */
    answer: ({ player, answers }: Asked, rev: number, now: number) =>
      Effect.gen(function* () {
        const id = parsePlayerId(player);
        if (id === undefined || answers.length === 0) return;
        for (const one of answers) {
          if (!(yield* playStore.answer(id, ANSWERS, one.id, rev, JSON.stringify(one.answer))))
            return yield* new Lost();
        }
        yield* playStore.keepNewest(id, ANSWERS);
        const refused = answers.filter((one) => "refused" in one.answer).length;
        yield* playStore.count(id, answers.length - refused, refused, now);
      }),
  };
}

/** Keeping sittings, on the database, the Coins and the play service's store. */
export const sittingWrites = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* sittingStore;
  const { follow, answer } = followsIn(yield* Coins, yield* PlayStore, store);
  const tell = yield* sittingsTold;

  return {
    store,
    /**
     * Keeps `next`, worked out from what was `from`, with what it owed paid off; and with `asked`, the
     * answers to those commands. Written only if it changed; but answers are kept whenever there are
     * some, at the `rev` stored. Once a change is kept, whoever is at the sitting is told (`told.ts`).
     * Gives back the `rev` it is at and the sitting kept.
     */
    keep: (id: string, from: Loaded, next: Sitting, now: number, asked?: Asked) =>
      Effect.gen(function* () {
        const after =
          next.owed.length > 0
            ? paidOff(
                next,
                next.owed.map((o) => o.key),
              )
            : next;
        const text = encodeSitting(after);
        const changed = text !== from.text;
        if (!changed && (asked?.answers.length ?? 0) === 0) return { rev: from.rev, sitting: after };
        const rev = from.rev + (changed ? 1 : 0);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const at = changed
                ? yield* store.write(id, from.rev, writingOf(after, text))
                : yield* store.isAt(id, from.rev);
              if (!at) return yield* new Lost();
              if (changed) yield* follow(id, from.sitting, after, next.owed, now);
              if (asked) yield* answer(asked, rev, now);
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        if (changed) tell(id, rev, from.sitting, after);
        return { rev, sitting: after };
      }),
    /**
     * Stores a new sitting, its opener seated and the opening logged, in one transaction that counts
     * the sittings not over first: `Full` at `MOST_NOT_OVER`, `Lost` when the opener is seated at
     * another; with `call`, the launch in a Discord call it is for sits at it, `Taken` when that has
     * one not over. Whichever, nothing is kept. Once it is kept, the open tables' room is told (`told.ts`).
     */
    create: (id: string, t: Sitting, now: number, call?: string) =>
      Effect.gen(function* () {
        const by = parsePlayerId(t.by);
        if (by === undefined) return yield* Effect.die(new Error(`A sitting opened by ${t.by}`));
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if ((yield* store.notOver) >= MOST_NOT_OVER) return yield* new Full();
              yield* store.create(id, by, now, writingOf(t, encodeSitting(t)));
              yield* follow(id, null, t, [], now);
              if (call !== undefined && !(yield* store.call(call, id, now))) return yield* new Taken();
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        tell(id, 0, null, t);
      }),
  };
});
