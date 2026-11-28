/**
 * Who is in a launch of the raid in a Discord call, as Discord says: a call's table seats only
 * someone Discord has in that launch, never on the page's word. Leaf asks Discord for the launch
 * (`GET /applications/{id}/activity-instances/{instance}`, with the application's bot's token) and
 * keeps whatever it heard `KEPT_FOR`: who is in it, nobody (a launch Discord does not know), or no
 * answer. So a call's arrivals mostly share one question. Someone not in a kept answer may have come
 * into the call after it: Discord is asked again, once that answer is `ASKED_AGAIN_AFTER` old.
 *
 * The bot's limits are everyone's, so one player cannot spend them: Leaf asks Discord for a player
 * only within their allowance (`ASKS`), and after a 429 asks nothing at all until Discord's
 * `Retry-After` has passed. With no bot token, no answer, or no asking left, nobody is let in: the
 * check fails closed.
 */
import { Cache, Clock, Context, Data, Duration, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { Allowances } from "../allowance.ts";
import { askBackend, type Asked, logFailure, UnexpectedStatus } from "../backend/failure.ts";
import { AppConfig, DISCORD_API } from "../config.ts";
import type { DiscordId } from "../wire.ts";

/** How long whatever Discord said of a launch is kept. */
export const KEPT_FOR = Duration.seconds(5);
/** How old a kept answer must be before someone missing from it has Discord asked again. */
export const ASKED_AGAIN_AFTER = 1000;
/** How often Leaf asks Discord for one player: six at once, then one every ten seconds. */
export const ASKS = { rate: 6 / 60, burst: 6 } as const;
/** How long Leaf asks Discord nothing after a 429 that does not say. */
const QUIET_FOR_MS = 5000;
/** How long Discord has to answer. */
const ASK_WITHIN = Duration.seconds(3);
/** How many launches' answers, and players' allowances, are kept at once. */
const KEPT = 500;

/** A launch as Discord answers, of what Leaf reads: the Discord ids of everyone in it. */
const Instance = Schema.Struct({ users: Schema.Array(Schema.String) });

/** Discord's word on a launch: who is in it, and when Leaf heard it. */
interface Heard {
  readonly users: ReadonlySet<string>;
  readonly at: number;
}

/** Whether someone is in a launch: in it, not in it, or Leaf cannot tell now. */
export type InCall = "in" | "out" | "unchecked";

/** Who asks: their Leaf id, whose allowance it is, and their Discord account. */
export interface Asker {
  readonly playerId: string;
  readonly discord: DiscordId;
}

/** Leaf has no way to ask Discord, may not ask it now, or Discord gave no answer it could use. */
class Unchecked extends Data.TaggedError("Unchecked") {}

/** How long a 429 asks Leaf to wait, in milliseconds, by its `Retry-After` in seconds. */
const quietFor = (response: HttpClientResponse.HttpClientResponse): number => {
  const seconds = Number(response.headers["retry-after"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : QUIET_FOR_MS;
};

export class CallMembers extends Context.Service<
  CallMembers,
  {
    /** Whether a Discord account is in a launch, as Discord says (or said within `KEPT_FOR`). */
    readonly check: (instance: string, asker: Asker) => Effect.Effect<InCall>;
  }
>()("leaf/CallMembers") {
  static readonly layer = Layer.effect(
    CallMembers,
    Effect.gen(function* () {
      const { activity: app } = yield* AppConfig;
      const client = yield* HttpClient.HttpClient;
      const token = app?.botToken;
      /** Until when Discord asked Leaf to ask nothing (a 429), by Leaf's clock. */
      const quietUntil = yield* Ref.make(0);
      const asks = new Allowances([ASKS], KEPT);

      /** Discord's word on a launch, now: nobody in one it does not know. */
      const ask = (instance: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (app === undefined || token === undefined || now < (yield* Ref.get(quietUntil)))
            return yield* new Unchecked();
          const url = `${DISCORD_API}/applications/${app.clientId}/activity-instances/${encodeURIComponent(instance)}`;
          const users = yield* client
            .execute(
              HttpClientRequest.get(url).pipe(
                HttpClientRequest.setHeader("authorization", `Bot ${Redacted.value(token)}`),
                HttpClientRequest.acceptJson,
              ),
            )
            .pipe(
              Effect.flatMap((response): Effect.Effect<readonly string[], Asked> => {
                if (response.status === 404) return Effect.succeed<readonly string[]>([]);
                if (response.status === 429)
                  return Effect.andThen(
                    Ref.set(quietUntil, now + quietFor(response)),
                    Effect.fail(new UnexpectedStatus({ status: 429 })),
                  );
                return HttpClientResponse.filterStatusOk(response).pipe(
                  Effect.flatMap(HttpClientResponse.schemaBodyJson(Instance)),
                  Effect.map((body) => body.users),
                );
              }),
              askBackend("Discord /activity-instances", ASK_WITHIN),
              // Logged with the route and why alone: never the request, which holds the token.
              Effect.tapError((failure) => logFailure("Discord could not say who is in a call", failure)),
              Effect.mapError(() => new Unchecked()),
            );
          return { users: new Set(users), at: now } satisfies Heard;
        });

      // Whatever was heard is kept as long: who is in a launch, nobody, or no answer.
      const heard = yield* Cache.makeWith(ask, { capacity: KEPT, timeToLive: () => KEPT_FOR });

      return CallMembers.of({
        check: (instance, { playerId, discord }) =>
          Effect.gen(function* () {
            const kept = yield* Cache.getOption(heard, instance);
            const now = yield* Clock.currentTimeMillis;
            if (Option.isSome(kept)) {
              if (kept.value.users.has(discord)) return "in" as const;
              // Not in an answer from before they came into the call, maybe: asked again once it is old enough.
              if (now - kept.value.at < ASKED_AGAIN_AFTER) return "out" as const;
            }
            // Discord is to be asked: only within the player's allowance.
            if (!asks.take(playerId, now, [1])) return "unchecked" as const;
            const fresh = Option.isSome(kept)
              ? yield* Cache.refresh(heard, instance)
              : yield* Cache.get(heard, instance);
            return fresh.users.has(discord) ? ("in" as const) : ("out" as const);
          }).pipe(Effect.catchTag("Unchecked", () => Effect.succeed("unchecked" as const))),
      });
    }),
  );
}
