/**
 * The raid in a Discord call (`http/activity.ts`): one sitting for each launch of it in a call. Discord
 * names a launch (its `instance`), and everyone who opens it sits at that launch's sitting: the first
 * to come opens it, the next sit down in order until it starts (when it starts is the sitting's own
 * rule: whoever opened it says so, or the eighth to sit). Anyone who comes once it has started is
 * turned away; once it is over, the next to come opens the launch's next. Leaf keeps which sitting a
 * launch sits at (`raid_sitting_calls`); the page says only the launch. A launch's sitting is its own:
 * it is not among the open sittings anyone may sit at.
 *
 * Only someone Discord has in the call sits at its sitting (`admitOf`, `members.ts`): the one rule of
 * a call's sitting, on every way of sitting down at one (here, and a `sit` sent to it as to any
 * sitting, `service.ts`).
 *
 * Someone sat at another launch's sitting that has not started has left that call: they get up from
 * it as they sit down at this one, in one step. What they are coming to is looked at first (started,
 * too soon to open one, a seat they may not leave), and the step itself is one transaction in the
 * lanes of both sittings: if this one will not have them after all, nothing of it is kept, and they
 * keep their seat where they were. Someone sat at a table anyone may sit at is left there, and told
 * they are at another.
 *
 * One launch's comings are taken one at a time in this Leaf; a sitting made by another Leaf beside it
 * in a deploy meanwhile is found by the database (`Taken`), and the caller is seated again from there.
 */
import { advance } from "@sequoia-leaf/raid/sitting/clock.ts";
import { decodeSitting } from "@sequoia-leaf/raid/sitting/keep.ts";
import type { Sitting } from "@sequoia-leaf/raid/sitting/sitting.ts";
import { Clock, Data, Effect, Option } from "effect";

import type { CallMembers } from "./members.ts";
import type { Batch, Caller, Create, Jobs, Opening, Parts } from "./service.ts";
import { Lost } from "./writes.ts";

/** Sitting down at a launch's sitting: as an opening goes, or turned away. */
export type Joining =
  | Exclude<Opening, { readonly status: "taken" }>
  /** The launch's sitting has started, or is full: nobody else sits at it now. */
  | { readonly status: "started" }
  /** Its sitting was stored by a newer Leaf, beside this one in a deploy: the page asks again. */
  | { readonly status: "updating" }
  /** Discord does not have the caller in the call. */
  | { readonly status: "not_in_call" }
  /** Discord cannot say who is in the call now (no bot token, no answer, or no asking left). */
  | { readonly status: "unchecked" };

/** Why someone may not sit at a call's sitting, if they may not. */
export type Barred = "not_in_call" | "unchecked";

/** How many times a coming is tried, when another made the launch's sitting meanwhile. */
const TRIES = 3;

/** A step that did not go: what the caller is told, all of it undone. `taken`: tried again from what is stored. */
class Undone extends Data.TaggedError("Undone")<{ readonly joining: Joining | { readonly status: "taken" } }> {}

/** Where a coming goes: the launch's sitting to sit at (none: a new one), and the call's sitting it leaves. */
interface Plan {
  readonly status: "go";
  readonly to: string | null;
  readonly leaving: string | null;
}

/** Whether a player is at a sitting: sat at it while it is open, or with a seat since it started, in or out. */
const isAt = (t: Sitting, player: string): boolean =>
  t.stage.at === "open"
    ? t.stage.sat.some((m) => m.id === player)
    : t.seats.some((seat) => seat.who.is === "member" && seat.who.id === player);

const hex = (n: number): string => n.toString(16).padStart(8, "0");
const isId = (id: string | null): id is string => id !== null;

/**
 * Whether a caller may sit at a launch's sitting: only someone Discord has in the call, never on the
 * page's word. Null when they may.
 */
export const admitOf =
  (members: CallMembers["Service"]) =>
  (caller: Caller, instance: string): Effect.Effect<Barred | null> =>
    caller.discord === null
      ? Effect.succeed("not_in_call")
      : Effect.map(members.check(instance, { playerId: caller.playerId, discord: caller.discord }), (said) =>
          said === "in" ? null : said === "out" ? "not_in_call" : "unchecked",
        );

/** What joining asks of the service besides its parts and jobs: its lane-free steps, and its rules. */
interface Steps {
  readonly batch: Batch;
  readonly create: Create;
  readonly admit: ReturnType<typeof admitOf>;
  readonly tooSoon: (caller: Caller, now: number) => Effect.Effect<boolean>;
}

/** Where a sitting stands at `now`, as stored and brought to then (none for one gone or that does not read). */
const stageAt = (store: Parts["store"], id: string, now: number) =>
  Effect.map(store.read(id), (row) => {
    const t = Option.isSome(row) ? decodeSitting(row.value.state) : null;
    return t === null ? null : advance(t, now).stage.at;
  });

/** Where a coming goes, looked at before anything changes. */
function plansOf({ store }: Parts, { bring, shown, freeUp }: Jobs, { tooSoon }: Steps) {
  /**
   * The launch's sitting the caller goes to: its id, or none for a new one (none yet, or the last
   * over); or the answer itself, shown the one they are at, or turned away from one started.
   */
  const toward = (caller: Caller, instance: string) =>
    Effect.gen(function* () {
      const at = Option.getOrNull(yield* store.callAt(instance));
      if (at === null) return null;
      const brought = yield* bring(at);
      if (brought === "updating") return { status: "updating" } satisfies Joining;
      if (typeof brought === "string" || brought.sitting.stage.at === "over") return null;
      if (isAt(brought.sitting, caller.playerId)) {
        const seen = yield* shown(at, brought.rev, brought.now, brought.sitting, caller.playerId);
        return { status: "shown", ...seen } satisfies Joining;
      }
      return brought.sitting.stage.at === "open" ? at : ({ status: "started" } satisfies Joining);
    });

  /**
   * Where the caller is to go: the plan of their coming; or turned away before anything changes, from
   * the launch's sitting, for a seat they may not leave (anything but another call's, not started), or
   * for opening one too soon.
   */
  return (caller: Caller, instance: string) =>
    Effect.gen(function* () {
      const to = yield* toward(caller, instance);
      if (to !== null && typeof to !== "string") return to;
      // Where they sit now, brought to the clock: one over by now has freed them.
      yield* freeUp(caller.playerId, to);
      const now = yield* Clock.currentTimeMillis;
      const seat = Option.getOrNull(yield* store.seatOf(caller.playerId));
      const leaving = seat !== null && seat !== to ? seat : null;
      const leavable =
        leaving === null ||
        (Option.isSome(yield* store.callOf(leaving)) && (yield* stageAt(store, leaving, now)) === "open");
      if (!leavable) return { status: "seated_elsewhere" } satisfies Joining;
      if (to === null && (yield* tooSoon(caller, now))) return { status: "too_soon" } satisfies Joining;
      return { status: "go", to, leaving } satisfies Plan;
    });
}

/**
 * The caller's coming, as one step: up from the sitting they leave, if any, and down at the launch's
 * (or a new one for it), in the lanes of both and one transaction, all of it kept or none.
 */
function movesOf({ store, dice, inLane, sql }: Parts, { nameOf }: Jobs, { batch, create }: Steps) {
  /** An id of the caller's command that nobody's page could have sent. */
  const fresh = (what: string) => Effect.map(Effect.all([dice, dice]), ([a, b]) => `call-${what}-${hex(a)}${hex(b)}`);
  /** `effect` in the lanes of every sitting in `ids`, always taken in one order, so that two steps never wait on each other. */
  const inLanes = <A, E, R>(ids: readonly string[], effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    ids.toSorted().reduceRight<Effect.Effect<A, E, R>>((inner, id) => inLane(id, inner), effect);

  /** Up from a call's sitting, in its lane at `now`: not from one started meanwhile, which would put them out of it. */
  const leave = (caller: Caller, name: string, id: string, now: number) =>
    Effect.gen(function* () {
      const stage = yield* stageAt(store, id, now);
      if (stage !== "open" && stage !== "over") return yield* new Undone({ joining: { status: "seated_elsewhere" } });
      const left = yield* batch(id, caller, name, [{ id: yield* fresh("leave"), command: { do: "leave" } }], now);
      if (left.status !== "done") return yield* new Undone({ joining: { status: "seated_elsewhere" } });
    });

  /** Down at the launch's sitting, in its lane at `now`; one that will not have them undoes the step. */
  const sit = (caller: Caller, name: string, id: string, now: number) =>
    Effect.gen(function* () {
      const sat = yield* batch(id, caller, name, [{ id: yield* fresh("sit"), command: { do: "sit" } }], now);
      if (sat.status === "updating") return yield* new Undone({ joining: { status: "updating" } });
      // Gone meanwhile: tried again, for the launch's next.
      if (sat.status !== "done") return yield* new Undone({ joining: { status: "taken" } });
      const { results, ...seen } = sat;
      const refused = results.find((r) => "refused" in r);
      if (refused === undefined) return { ...seen, status: "shown" } satisfies Joining;
      const elsewhere = "refused" in refused && refused.refused === "seated_elsewhere";
      return yield* new Undone({ joining: { status: elsewhere ? "seated_elsewhere" : "started" } });
    });

  return (caller: Caller, instance: string, { to, leaving }: Plan) =>
    Effect.gen(function* () {
      const name = yield* nameOf(caller);
      const step = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (leaving !== null) yield* leave(caller, name, leaving, now);
        if (to !== null) return yield* sit(caller, name, to, now);
        const opened = yield* create(caller, name, now, instance);
        return opened.status === "shown" ? opened : yield* new Undone({ joining: opened });
      });
      return yield* inLanes([to, leaving].filter(isId), sql.withTransaction(step)).pipe(
        Effect.retry({ while: (error) => error instanceof Lost, times: TRIES - 1 }),
        Effect.catchTag("Undone", ({ joining }) => Effect.succeed(joining)),
        Effect.orDie,
      );
    });
}

/** Joining the launches' sittings, from the service's parts, its jobs and its steps. */
export function joinOf(parts: Parts, jobs: Jobs, steps: Steps) {
  const planOf = plansOf(parts, jobs, steps);
  const move = movesOf(parts, jobs, steps);
  return (caller: Caller, instance: string) =>
    Effect.gen(function* () {
      const barred = yield* steps.admit(caller, instance);
      if (barred !== null) return { status: barred } satisfies Joining;
      if (!parts.pace.take(caller.playerId, yield* Clock.currentTimeMillis, [1, 1]))
        return { status: "slow" } satisfies Joining;
      return yield* parts.inLane(
        `call:${instance}`,
        Effect.gen(function* () {
          for (let tries = 0; tries < TRIES; tries++) {
            const plan = yield* planOf(caller, instance);
            if (plan.status !== "go") return plan;
            const moved = yield* move(caller, instance, plan);
            if (moved.status !== "taken") return moved;
          }
          return { status: "slow" } satisfies Joining;
        }),
      );
    });
}
