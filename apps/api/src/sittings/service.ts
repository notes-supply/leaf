/**
 * Leaf's side of the raid's sittings (live tables: `packages/raid/src/sitting/`): storing them, what a
 * page asks of them, the clock, Coins, and what Leaf remembers of a finished one.
 *
 * Every read and every command brings a sitting to Leaf's clock first (`advance`, or `command`, which
 * does it), one job at a time for each sitting (its lane, held only while somebody waits on it), and
 * writes it back only if it changed, in one transaction with everything that follows from it
 * (`writes.ts`); once it is kept, every member at it is told, and so are those looking at the open
 * tables when their list changed (`told.ts`). No timer has to fire for a sitting to be right: the minute's sweep brings every
 * sitting whose due moment has passed to the clock, so that Coins are paid, seats freed and tables
 * closed even when nobody looks. Leaf's dice for each command come from `SecureRandom`.
 */
import { type Balances, COMMAND_ID, DAY_MS, MOST_FLUSHED, type PlayerId } from "@sequoia-leaf/core";
import { advance } from "@sequoia-leaf/raid/sitting/clock.ts";
import { command, openSitting, readCommand, type SittingCommand } from "@sequoia-leaf/raid/sitting/commands.ts";
import { decodeSitting, sittingIsNewer } from "@sequoia-leaf/raid/sitting/keep.ts";
import type { Member, Sitting } from "@sequoia-leaf/raid/sitting/sitting.ts";
import { type SittingView, sittingView } from "@sequoia-leaf/raid/sitting/view.ts";
import { Clock, Context, Effect, Layer, Option, RcMap, Schema, Semaphore } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";

import { PlayerNames } from "../game/names.ts";
import { Coins } from "../play/coins.ts";
import { PlayPace } from "../play/pace.ts";
import { PlayStore } from "../play/store.ts";
import type { DiscordId } from "../wire.ts";
import { admitOf, type Joining, joinOf } from "./calls.ts";
import { CallMembers } from "./members.ts";
import type { Record } from "./store.ts";
import { type Answer, ANSWERS, type Loaded, type Lost, MOST_NOT_OVER, sittingWrites } from "./writes.ts";

/** A player opens at most one sitting in this long. */
export const OPEN_EVERY_MS = 60_000;
/** How many open sittings are listed, the longest open first. */
export const LISTED = 50;
/** How long a sitting is kept after it ended, before it is let go of (its places stay for good). */
export const KEPT_MS = DAY_MS;
/** How many times in all a job is done, each from what is stored, when what is stored moves on under it. */
const TRIES = 3;

/**
 * Who calls: their Leaf id, the name their session gave, should Leaf have none of its own for them,
 * and their Discord account if their session names one (whom Discord may have in a call).
 */
export interface Caller {
  readonly playerId: PlayerId;
  readonly username: string;
  readonly discord: DiscordId | null;
}

/** A sitting as a caller is shown it: its id and `rev`, Leaf's clock, the view, and the caller's balances. */
export interface Shown {
  readonly id: string;
  readonly rev: number;
  readonly now: number;
  readonly view: SittingView;
  readonly purse: Balances;
}

/** What one command answered: what happened, or the refusal's code and sentence. */
export type Result = { readonly id: string } & Answer;

export type Reading =
  | ({ readonly status: "shown" } & Shown)
  /** The caller's `rev` is the sitting's, brought to now: nothing to show. */
  | { readonly status: "unchanged"; readonly id: string; readonly rev: number; readonly now: number }
  | { readonly status: "missing" }
  | { readonly status: "unreadable" }
  /** Stored by a newer Leaf, beside this one in a deploy: left as it is, for the page to ask again. */
  | { readonly status: "updating" };

export type Opening =
  | ({ readonly status: "shown" } & Shown)
  | { readonly status: "seated_elsewhere" }
  /** As many sittings as may be are not over. */
  | { readonly status: "full" }
  /** The caller opened one less than `OPEN_EVERY_MS` ago. */
  | { readonly status: "too_soon" }
  | { readonly status: "slow" }
  /** The launch in a Discord call it was for has one not over, made meanwhile: nothing was opened. */
  | { readonly status: "taken" };

export type Sending =
  | ({ readonly status: "done"; readonly results: readonly Result[] } & Shown)
  | { readonly status: "missing" }
  | { readonly status: "unreadable" }
  | { readonly status: "updating" }
  | { readonly status: "invalid"; readonly why: string }
  | { readonly status: "slow" }
  /** A sit at a call's sitting by someone Discord does not have in the call: nothing was done. */
  | { readonly status: "not_in_call" }
  /** A sit at a call's sitting while Discord cannot say who is in the call: nothing was done. */
  | { readonly status: "unchecked" };

/** An open sitting to sit at: its id, whoever opened it, how many sat, and the moment it closes. */
export interface Listed {
  readonly id: string;
  readonly by: Member;
  readonly sat: number;
  readonly closes: number;
}

/** The open sittings, and the one the caller is seated at, if any, as of Leaf's clock. */
export interface Listing {
  readonly now: number;
  readonly open: readonly Listed[];
  readonly yours: string | null;
}

/** A command as it came, read, with its id. */
export interface Sent {
  readonly id: string;
  readonly command: SittingCommand;
}

/** What a player at one sitting may not do at another. */
const SEATED_ELSEWHERE: Answer = { refused: "seated_elsewhere", why: "You are at another table." };

const KeptAnswer = Schema.Union([
  Schema.Struct({ notes: Schema.Array(Schema.Unknown) }),
  Schema.Struct({ refused: Schema.String, why: Schema.String }),
]);
const readKept = Schema.decodeUnknownSync(Schema.fromJsonString(KeptAnswer));

const isRecord = (v: unknown): v is { readonly [key: string]: unknown } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The commands of a batch with their ids, or why the batch is not one. */
function sentOf(commands: readonly unknown[]): readonly Sent[] | string {
  if (commands.length > MOST_FLUSHED) return `A batch holds at most ${MOST_FLUSHED} commands`;
  const sent: Sent[] = [];
  for (const raw of commands) {
    if (!isRecord(raw) || typeof raw["id"] !== "string" || !COMMAND_ID.test(raw["id"])) {
      return "Every command needs an id of its own: up to 64 letters, digits and _ . : -";
    }
    const id = raw["id"];
    if (sent.some((other) => other.id === id)) return "Two commands in the batch have the same id";
    const read = readCommand(raw);
    if (read === null) return `Command ${id} is not one of the table's`;
    sent.push({ id, command: read });
  }
  return sent;
}

/** An open sitting as it is listed; none for one that is not open. */
function listed(id: string, t: Sitting): Listed[] {
  const { stage } = t;
  if (stage.at !== "open") return [];
  const by = stage.sat.find((m) => m.id === t.by);
  return by ? [{ id, by, sat: stage.sat.length, closes: stage.until }] : [];
}

const hex = (n: number): string => n.toString(16).padStart(8, "0");

/** A sitting the sweep could not bring on, logged: the others go on. */
const failed = (sitting: string, defect: unknown) =>
  Effect.annotateLogs(Effect.logError("Bringing a sitting to the clock failed", defect), { sitting });

/** What the service is made of: the stores, Coins, names, the players' allowances, Leaf's dice, and the lanes. */
const parts = Effect.gen(function* () {
  const writes = yield* sittingWrites;
  const random = yield* SecureRandom.SecureRandom;
  // One job at a time for each sitting: its lane is held while anybody waits on it, and let go after.
  const lanes = yield* RcMap.make({ lookup: (_id: string) => Semaphore.make(1) });
  return {
    writes,
    store: writes.store,
    playStore: yield* PlayStore,
    coins: yield* Coins,
    names: yield* PlayerNames,
    pace: yield* PlayPace,
    members: yield* CallMembers,
    sql: yield* SqlClient.SqlClient,
    dice: random.intBetween(0, 0xffffffff),
    inLane: <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(Effect.flatMap(RcMap.get(lanes, id), (lane) => lane.withPermit(effect))),
  };
});
export type Parts = Effect.Success<typeof parts>;

/** The jobs every route shares: a sitting read, brought to the clock, and shown. */
function jobsOf({ writes, store, coins, names, inLane }: Parts) {
  /** Does `work` in the sitting's lane at Leaf's clock as it gets its turn, again from what is stored when that moved on. */
  const job = <A>(id: string, work: (now: number) => Effect.Effect<A, Lost>) =>
    inLane(id, Effect.flatMap(Clock.currentTimeMillis, work).pipe(Effect.retry({ times: TRIES - 1 }), Effect.orDie));
  /**
   * A sitting as stored, read. One a newer Leaf wrote is left exactly as it is, seats and all; one that
   * does not read otherwise is logged and has its seats freed, and its state kept as it is.
   */
  const load = (id: string, now: number) =>
    Effect.gen(function* () {
      const row = yield* store.read(id);
      if (Option.isNone(row)) return "missing" as const;
      const { rev, state } = row.value;
      const sitting = decodeSitting(state);
      if (sitting !== null) return { rev, text: state, sitting } satisfies Loaded;
      const newer = sittingIsNewer(state);
      const said = newer ? "is a newer Leaf's; it is left as it is" : "does not read; it is kept as it is";
      yield* Effect.annotateLogs((newer ? Effect.logWarning : Effect.logError)(`A sitting stored ${said}`), {
        sitting: id,
        rev,
      });
      if (newer) return "updating" as const;
      yield* store.shelve(id, rev, now);
      return "unreadable" as const;
    });
  /** A sitting brought to Leaf's clock and kept if that changed it. */
  const bring = (id: string) =>
    job(id, (now) =>
      Effect.gen(function* () {
        const from = yield* load(id, now);
        if (typeof from === "string") return from;
        return { ...(yield* writes.keep(id, from, advance(from.sitting, now), now)), now };
      }),
    );
  const shown = (id: string, rev: number, now: number, t: Sitting, viewer: PlayerId) =>
    Effect.map(coins.balances(viewer), (purse): Shown => ({ id, rev, now, view: sittingView(t, viewer), purse }));
  /** The sitting a player is seated at, other than `here`, brought to the clock: one over by now frees them. */
  const freeUp = (player: PlayerId, here: string | null) =>
    Effect.gen(function* () {
      const seat = yield* store.seatOf(player);
      if (Option.isSome(seat) && seat.value !== here) yield* bring(seat.value);
    });
  /** How Leaf names a player to others, or else as their session does. */
  const nameOf = ({ playerId, username }: Caller) =>
    Effect.map(names.of([playerId]), (named) => named.get(playerId) ?? username);
  return { job, load, bring, shown, freeUp, nameOf };
}
export type Jobs = ReturnType<typeof jobsOf>;

/**
 * A new sitting with the caller sat at it, opened at `now`; with `call`, the sitting of that launch in a
 * Discord call. No lane: nobody knows its id yet. Seated somewhere meanwhile (by another request of
 * theirs), the last sitting there may be opened meanwhile, or the launch's made meanwhile: nothing is kept.
 */
function creatorOf({ writes, dice }: Parts, { shown }: Jobs) {
  return (caller: Caller, name: string, now: number, call?: string) =>
    Effect.gen(function* () {
      const id = `${hex(yield* dice)}${hex(yield* dice)}`;
      const t = openSitting({ now, seed: yield* dice, player: { id: caller.playerId, name } });
      const refused = yield* writes.create(id, t, now, call).pipe(
        Effect.as(null),
        Effect.catchTags({
          Lost: () => Effect.succeed<Opening>({ status: "seated_elsewhere" }),
          Full: () => Effect.succeed<Opening>({ status: "full" }),
          Taken: () => Effect.succeed<Opening>({ status: "taken" }),
        }),
      );
      if (refused !== null) return refused;
      return { status: "shown", ...(yield* shown(id, 0, now, t, caller.playerId)) } satisfies Opening;
    });
}
export type Create = ReturnType<typeof creatorOf>;

/** A batch of commands at a sitting, in its lane at `now`: each done in order, then the sitting kept with their answers. */
function batchOf({ writes, store, playStore, dice }: Parts, { load, shown }: Jobs) {
  return (id: string, caller: Caller, name: string, sent: readonly Sent[], now: number) =>
    Effect.gen(function* () {
      const from = yield* load(id, now);
      if (typeof from === "string") return { status: from } satisfies Sending;
      const elsewhere = Option.getOrNull(yield* store.seatOf(caller.playerId));
      const player: Member = { id: caller.playerId, name };
      let t = from.sitting;
      const results: Result[] = [];
      const answers: { id: string; answer: Answer }[] = [];
      for (const one of sent) {
        const before = yield* playStore.answered(caller.playerId, ANSWERS, one.id);
        if (Option.isSome(before)) {
          results.push({ id: one.id, ...readKept(before.value) });
          continue;
        }
        let answer = SEATED_ELSEWHERE;
        if (one.command.do !== "sit" || elsewhere === null || elsewhere === id) {
          const done = command(t, one.command, { now, seed: yield* dice, player });
          t = done.sitting;
          answer = done.ok ? { notes: done.notes } : { refused: done.code, why: done.why };
        }
        results.push({ id: one.id, ...answer });
        answers.push({ id: one.id, answer });
      }
      const kept = yield* writes.keep(id, from, advance(t, now), now, { player: caller.playerId, answers });
      return {
        status: "done",
        results,
        ...(yield* shown(id, kept.rev, now, kept.sitting, caller.playerId)),
      } satisfies Sending;
    });
}

export type Batch = ReturnType<typeof batchOf>;

/**
 * The raid's sittings, as Leaf keeps them. Anyone signed in may open or sit at one, guests too; a
 * player is seated at one sitting at a time, held by the database (`raid_sitting_seats`).
 */
export class Sittings extends Context.Service<
  Sittings,
  {
    /** The open sittings to sit at, and the caller's own, if any. */
    readonly list: (player: PlayerId) => Effect.Effect<Listing>;
    /** Opens a sitting with the caller sat at it. */
    readonly open: (caller: Caller) => Effect.Effect<Opening>;
    /**
     * Sits the caller at the sitting of a launch in a Discord call (`calls.ts`): everyone who opens
     * that launch sits at one, the first to come opening it, until it starts.
     */
    readonly join: (caller: Caller, instance: string) => Effect.Effect<Joining>;
    /** A sitting brought to Leaf's clock, as the viewer is shown it; or unchanged, for the `rev` the page has. */
    readonly read: (id: string, viewer: PlayerId, rev?: number) => Effect.Effect<Reading>;
    /** Does a batch of commands at a sitting, as they came off the wire, each with its id. */
    readonly send: (id: string, caller: Caller, commands: readonly unknown[]) => Effect.Effect<Sending>;
    /** A player's record: sittings finished, won, and in the first four. */
    readonly record: (player: PlayerId) => Effect.Effect<Record>;
    /** Brings every sitting due by now to the clock, and lets go of those over for `KEPT_MS`. Gives back how many were due. */
    readonly sweep: Effect.Effect<number>;
  }
>()("leaf/Sittings") {
  static readonly layer = Layer.effect(
    Sittings,
    Effect.gen(function* () {
      const made = yield* parts;
      const { store, playStore, pace } = made;
      const jobs = jobsOf(made);
      const batch = batchOf(made, jobs);
      const create = creatorOf(made, jobs);
      // The one rule of a call's sitting: Discord has the caller in the call (`calls.ts`).
      const admit = admitOf(made.members);
      const tooSoon = (caller: Caller, now: number) =>
        Effect.map(store.openedSince(caller.playerId, now - OPEN_EVERY_MS), (n) => n > 0);
      const service: Omit<Sittings["Service"], "join"> = {
        list: (player) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const open = (yield* store.open(now, LISTED)).flatMap((row) => {
              const t = decodeSitting(row.state);
              return t === null ? [] : listed(row.id, t);
            });
            return { now, open, yours: Option.getOrNull(yield* store.seatOf(player)) };
          }),
        open: (caller) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (!pace.take(caller.playerId, now, [1, 1])) return { status: "slow" } satisfies Opening;
            if (yield* tooSoon(caller, now)) return { status: "too_soon" } satisfies Opening;
            yield* jobs.freeUp(caller.playerId, null);
            if (Option.isSome(yield* store.seatOf(caller.playerId)))
              return { status: "seated_elsewhere" } satisfies Opening;
            return yield* create(caller, yield* jobs.nameOf(caller), now);
          }),
        read: (id, viewer, rev) =>
          Effect.gen(function* () {
            // Nothing due and nothing written since the page's `rev`: unchanged, read no further.
            const at = rev === undefined ? Option.none() : yield* store.at(id);
            const now = yield* Clock.currentTimeMillis;
            if (Option.isSome(at) && at.value.rev === rev && (at.value.dueAt === null || at.value.dueAt > now))
              return { status: "unchanged", id, rev, now } satisfies Reading;
            const brought = yield* jobs.bring(id);
            if (typeof brought === "string") return { status: brought } satisfies Reading;
            if (brought.rev === rev) return { status: "unchanged", id, rev, now: brought.now } satisfies Reading;
            const shown = yield* jobs.shown(id, brought.rev, brought.now, brought.sitting, viewer);
            return { status: "shown", ...shown } satisfies Reading;
          }),
        send: (id, caller, commands) =>
          Effect.gen(function* () {
            const sent = sentOf(commands);
            if (typeof sent === "string") return { status: "invalid", why: sent } satisfies Sending;
            // A command answered before takes nothing of the allowance: a page sends again what may have come already.
            let fresh = 0;
            for (const one of sent)
              if (Option.isNone(yield* playStore.answered(caller.playerId, ANSWERS, one.id))) fresh++;
            if (!pace.take(caller.playerId, yield* Clock.currentTimeMillis, [1, fresh]))
              return { status: "slow" } satisfies Sending;
            const sits = sent.some((one) => one.command.do === "sit");
            // A call's sitting seats only someone Discord has in the call, whichever way they ask.
            const call = sits ? Option.getOrNull(yield* store.callOf(id)) : null;
            const barred = call === null ? null : yield* admit(caller, call);
            if (barred !== null) return { status: barred } satisfies Sending;
            if (sits) yield* jobs.freeUp(caller.playerId, id);
            const name = sits ? yield* jobs.nameOf(caller) : caller.username;
            return yield* jobs.job(id, (now) => batch(id, caller, name, sent, now));
          }),
        record: (player) => store.record(player),
        sweep: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const due = yield* store.due(now, MOST_NOT_OVER);
          for (const id of due) yield* Effect.catchDefect(jobs.bring(id), (defect) => failed(id, defect));
          yield* store.letGo(now - KEPT_MS);
          return due.length;
        }),
      };
      return Sittings.of({ ...service, join: joinOf(made, jobs, { batch, create, admit, tooSoon }) });
    }),
  );
}
