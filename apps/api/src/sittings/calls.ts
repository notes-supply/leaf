/**
 * The raid in a Discord call (`http/activity.ts`): one sitting for each launch of it in a call. Discord
 * names a launch (its `instance`), and everyone who opens it sits at that launch's sitting: the first
 * to come opens it, the next sit down in order until it starts (when it starts is the sitting's own
 * rule: whoever opened it says so, or the eighth to sit). Anyone who comes once it has started is
 * turned away; once it is over, the next to come opens the launch's next. Leaf keeps which sitting a
 * launch sits at (`raid_sitting_calls`); the page says only the launch. A launch's sitting is its own:
 * it is not among the open sittings anyone may sit at.
 *
 * One launch's comings are taken one at a time in this Leaf; a sitting made by another Leaf beside it
 * in a deploy meanwhile is found by the database (`Taken`), and the caller sits at that one instead.
 */
import type { Sitting } from "@sequoia-leaf/raid/sitting/sitting.ts";
import { Effect, Option } from "effect";

import type { Caller, Jobs, Opening, Parts, Sittings } from "./service.ts";

/** Sitting down at a launch's sitting: as an opening goes, or turned away from one started. */
export type Joining =
  | Exclude<Opening, { readonly status: "taken" }>
  /** The launch's sitting has started, or is full: nobody else sits at it now. */
  | { readonly status: "started" }
  /** Its sitting was stored by a newer Leaf, beside this one in a deploy: the page asks again. */
  | { readonly status: "updating" };

/** How many times a coming is tried, when another made the launch's sitting meanwhile. */
const TRIES = 3;

/** Whether a player is at a sitting: sat at it while it is open, or with a seat since it started, in or out. */
const isAt = (t: Sitting, player: string): boolean =>
  t.stage.at === "open"
    ? t.stage.sat.some((m) => m.id === player)
    : t.seats.some((seat) => seat.who.is === "member" && seat.who.id === player);

const hex = (n: number): string => n.toString(16).padStart(8, "0");

/** Joining the launches' sittings, from the service's parts, its jobs, and its own opening and commands. */
export function joinOf(
  { store, dice, inLane }: Parts,
  { bring, shown }: Jobs,
  { open, send }: Pick<Sittings["Service"], "open" | "send">,
) {
  /**
   * The caller at a launch's sitting `id`: shown it when they are at it or sit down now, turned away
   * from one started; null when it is over or gone, for the caller to open the launch's next.
   */
  const sitAt = (caller: Caller, id: string) =>
    Effect.gen(function* () {
      const brought = yield* bring(id);
      if (brought === "updating") return { status: "updating" } satisfies Joining;
      if (typeof brought === "string" || brought.sitting.stage.at === "over") return null;
      if (isAt(brought.sitting, caller.playerId)) {
        const seen = yield* shown(id, brought.rev, brought.now, brought.sitting, caller.playerId);
        return { status: "shown", ...seen } satisfies Joining;
      }
      if (brought.sitting.stage.at !== "open") return { status: "started" } satisfies Joining;
      const sat = yield* send(id, caller, [{ id: `call-sit-${hex(yield* dice)}${hex(yield* dice)}`, do: "sit" }]);
      if (sat.status === "missing" || sat.status === "unreadable") return null;
      if (sat.status === "updating" || sat.status === "slow") return { status: sat.status } satisfies Joining;
      if (sat.status === "invalid") return yield* Effect.die(new Error(`A sit was not a command: ${sat.why}`));
      const { results, ...seen } = sat;
      const refused = results.find((r) => "refused" in r);
      if (refused === undefined) return { ...seen, status: "shown" } satisfies Joining;
      return "refused" in refused && refused.refused === "seated_elsewhere"
        ? ({ status: "seated_elsewhere" } satisfies Joining)
        : ({ status: "started" } satisfies Joining);
    });

  return (caller: Caller, instance: string) =>
    inLane(
      `call:${instance}`,
      Effect.gen(function* () {
        for (let tries = 0; tries < TRIES; tries++) {
          const at = yield* store.callAt(instance);
          const seated = Option.isSome(at) ? yield* sitAt(caller, at.value) : null;
          if (seated !== null) return seated;
          const opened = yield* open(caller, instance);
          if (opened.status !== "taken") return opened;
        }
        return { status: "slow" } satisfies Joining;
      }),
    );
}
