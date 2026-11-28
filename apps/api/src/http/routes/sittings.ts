import { Clock, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Visits } from "../../activity/visits.ts";
import { CurrentIdentity, type Identity, LeafApi, SittingBodyErrors } from "../../api/api.ts";
import { Invalid, SlowDown } from "../../api/errors.ts";
import { CallUnchecked, SittingMissing, SittingRefused, SittingUpdating } from "../../api/sittings.ts";
import type { Joining } from "../../sittings/calls.ts";
import { CallMembers } from "../../sittings/members.ts";
import { type Caller, type Opening, type Shown, Sittings } from "../../sittings/service.ts";
import { payloadError } from "./middleware.ts";
import { iso, notYou, unreadable } from "./shared.ts";

/** Who calls a sitting, as the sittings service needs to know them. */
const callerOf = (identity: Identity): Caller => ({ playerId: identity.playerId, username: identity.username });

/** A sitting as an answer sends it. */
const shownJson = ({ id, rev, now, view, purse }: Shown) => ({ id, rev, now: iso(now), state: view, purse });

const missing = new SittingMissing({ code: "no_such_sitting", message: "There is no such table" });
/** A table a newer Leaf stored, beside this one in a deploy: the page asks again. */
const updating = new SittingUpdating({
  code: "sitting_updating",
  message: "This table is being updated. Try again in a moment.",
});
/** Discord could not say who is in the call: nobody is seated on the page's word. */
const unchecked = new CallUnchecked({
  code: "call_unchecked",
  message: "Can't check this call right now. Try again in a moment",
});
const notInCall = new SittingRefused({ code: "not_in_call", message: "You are not in this call" });
const slow = new SlowDown({
  code: "slow_down",
  message: "Commands are coming faster than Leaf takes them. Send them again in a moment",
});

/** The `rev` a page says it has, if it says one that is one. */
const revOf = (rev: string | undefined): number | undefined => (/^\d{1,12}$/.test(rev ?? "") ? Number(rev) : undefined);

/** An opening of a sitting whose body is not `{ "player" }` (and `"instance"`, in a Discord call) gets `invalid_command`. */
export const SittingBodyErrorsLive = Layer.succeed(SittingBodyErrors)(
  payloadError(
    new Invalid({
      code: "invalid_command",
      message: 'Send { "player": "<your id>" } to open a table, with "instance": "<the launch>" in a Discord call',
    }),
  ),
);

/** A sitting opened, answered: shown, or refused with what it was refused for. */
const opened = (o: Exclude<Opening, { readonly status: "taken" }>) => {
  switch (o.status) {
    case "shown":
      return Effect.succeed(shownJson(o));
    case "seated_elsewhere":
      return Effect.fail(new SittingRefused({ code: "seated_elsewhere", message: "You are at another table." }));
    case "full":
      return Effect.fail(
        new SittingRefused({
          code: "sittings_full",
          message: "As many tables are going as there may be. Try again in a while",
        }),
      );
    case "too_soon":
      return Effect.fail(
        new SlowDown({ code: "slow_down", message: "You opened a table a moment ago. Wait a minute" }),
      );
    case "slow":
      return Effect.fail(slow);
  }
};

/** A call's sitting sat at, answered as an opening is, or turned away from one started. */
const joined = (j: Joining) =>
  j.status === "started"
    ? Effect.fail(
        new SittingRefused({
          code: "table_started",
          message: "This table has started. Join the next one when it ends",
        }),
      )
    : j.status === "updating"
      ? Effect.fail(updating)
      : opened(j);

export const GameSittingsHandlers = HttpApiBuilder.group(LeafApi, "gameSittings", (handlers) =>
  Effect.gen(function* () {
    const sittings = yield* Sittings;
    const visits = yield* Visits;
    const members = yield* CallMembers;
    return (
      handlers
        .handle("sittings", () =>
          Effect.gen(function* () {
            const { playerId } = yield* CurrentIdentity;
            const { now, open, yours } = yield* sittings.list(playerId);
            const listed = open.map(({ id, by, sat, closes }) => ({ id, by, sat, closes: iso(closes) }));
            return { now: iso(now), open: listed, yours };
          }),
        )
        .handle("openSitting", ({ payload }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (payload.player !== identity.playerId) return yield* notYou;
            const made = yield* sittings.open(callerOf(identity));
            // Opened for no launch, it is never another's.
            if (made.status === "taken") return yield* Effect.die(new Error("A table for no call was taken"));
            if (made.status === "shown") yield* visits.acted(identity.playerId, yield* Clock.currentTimeMillis);
            return yield* opened(made);
          }),
        )
        // The table of a launch in a Discord call: the caller's, opened or sat at, or why not. Only
        // someone Discord has in the launch sits at it, never on the page's word.
        .handle("callSitting", ({ payload }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (payload.player !== identity.playerId) return yield* notYou;
            const { discord } = identity;
            const inCall = discord === null ? "out" : yield* members.check(payload.instance, discord);
            if (inCall === "unchecked") return yield* unchecked;
            if (inCall === "out") return yield* notInCall;
            const at = yield* sittings.join(callerOf(identity), payload.instance);
            if (at.status === "shown") yield* visits.acted(identity.playerId, yield* Clock.currentTimeMillis);
            return yield* joined(at);
          }),
        )
        .handle("sittingRecord", () =>
          Effect.gen(function* () {
            const { playerId } = yield* CurrentIdentity;
            const { played, won, four } = yield* sittings.record(playerId);
            return { played, won, top_four: four };
          }),
        )
        // Brought to Leaf's clock first; with the `rev` the page has and nothing since, answered unchanged.
        .handle("sitting", ({ params, query }) =>
          Effect.gen(function* () {
            const { playerId } = yield* CurrentIdentity;
            const read = yield* sittings.read(params.id, playerId, revOf(query.rev));
            switch (read.status) {
              case "shown":
                return shownJson(read);
              case "unchanged":
                return { id: read.id, rev: read.rev, now: iso(read.now), unchanged: true as const };
              case "missing":
                return yield* missing;
              case "unreadable":
                return yield* unreadable;
              case "updating":
                return yield* updating;
            }
          }),
        )
        // Commands, done in order in one transaction; one whose id was seen before answers as it did then.
        .handle("sittingCommand", ({ params, payload }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (payload.player !== identity.playerId) return yield* notYou;
            const sent = yield* sittings.send(params.id, callerOf(identity), payload.commands);
            switch (sent.status) {
              case "done":
                yield* visits.acted(identity.playerId, yield* Clock.currentTimeMillis);
                return { ...shownJson(sent), results: sent.results };
              case "invalid":
                return yield* new Invalid({ code: "invalid_command", message: sent.why });
              case "missing":
                return yield* missing;
              case "unreadable":
                return yield* unreadable;
              case "updating":
                return yield* updating;
              case "slow":
                return yield* slow;
            }
          }),
        )
    );
  }),
);
