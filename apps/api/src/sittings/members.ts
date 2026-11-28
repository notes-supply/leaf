/**
 * Who is in a launch of the raid in a Discord call, as Discord says: a call's table seats only
 * someone Discord has in that launch, never on the page's word. Leaf asks Discord for the launch
 * (`GET /applications/{id}/activity-instances/{instance}`, with the application's bot's token) and
 * keeps its answer `KEPT_FOR`, so that a call's arrivals mostly share one question. Someone who is not
 * in a kept answer may have come into the call after it: Discord is asked again, once its answer is
 * `ASKED_AGAIN_AFTER` old. A launch Discord does not know has nobody in it. With no bot token, or no
 * answer from Discord, nobody is let in: the check fails closed.
 */
import { Cache, Clock, Context, Data, Duration, Effect, Exit, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { askBackend, logFailure } from "../backend/failure.ts";
import { AppConfig, DISCORD_API } from "../config.ts";
import type { DiscordId } from "../wire.ts";

/** How long Discord's answer for a launch is kept. */
export const KEPT_FOR = Duration.seconds(5);
/** How old a kept answer must be before someone missing from it has Discord asked again. */
export const ASKED_AGAIN_AFTER = 1000;
/** How long Discord has to answer. */
const ASK_WITHIN = Duration.seconds(3);
/** How many launches' answers are kept at once. */
const KEPT = 500;

/** A launch as Discord answers, of what Leaf reads: the Discord ids of everyone in it. */
const Instance = Schema.Struct({ users: Schema.Array(Schema.String) });

/** Discord's word on a launch: who is in it, and when Leaf heard it. */
interface Heard {
  readonly users: ReadonlySet<string>;
  readonly at: number;
}

/** Whether someone is in a launch: in it, not in it, or Leaf cannot tell (no token, or no answer). */
export type InCall = "in" | "out" | "unchecked";

/** Leaf has no way to ask Discord, or Discord gave no answer it could use. */
class Unchecked extends Data.TaggedError("Unchecked") {}

export class CallMembers extends Context.Service<
  CallMembers,
  {
    /** Whether a Discord account is in a launch, as Discord says (or said within `KEPT_FOR`). */
    readonly check: (instance: string, discord: DiscordId) => Effect.Effect<InCall>;
  }
>()("leaf/CallMembers") {
  static readonly layer = Layer.effect(
    CallMembers,
    Effect.gen(function* () {
      const { activity: app } = yield* AppConfig;
      const client = yield* HttpClient.HttpClient;
      const token = app?.botToken;

      /** Discord's word on a launch, now. */
      const ask = (instance: string) =>
        Effect.gen(function* () {
          if (app === undefined || token === undefined) return yield* new Unchecked();
          const url = `${DISCORD_API}/applications/${app.clientId}/activity-instances/${encodeURIComponent(instance)}`;
          const users = yield* client
            .execute(
              HttpClientRequest.get(url).pipe(
                HttpClientRequest.setHeader("authorization", `Bot ${Redacted.value(token)}`),
                HttpClientRequest.acceptJson,
              ),
            )
            .pipe(
              Effect.flatMap((response) =>
                // A launch Discord does not know (over, or never one) has nobody in it.
                response.status === 404
                  ? Effect.succeed<readonly string[]>([])
                  : HttpClientResponse.filterStatusOk(response).pipe(
                      Effect.flatMap(HttpClientResponse.schemaBodyJson(Instance)),
                      Effect.map((body) => body.users),
                    ),
              ),
              askBackend("Discord /activity-instances", ASK_WITHIN),
              // Logged with the route and why alone: never the request, which holds the token.
              Effect.tapError((failure) => logFailure("Discord could not say who is in a call", failure)),
              Effect.mapError(() => new Unchecked()),
            );
          return { users: new Set(users), at: yield* Clock.currentTimeMillis } satisfies Heard;
        });

      const heard = yield* Cache.makeWith(ask, {
        capacity: KEPT,
        // Only an answer is kept: no answer is asked about again.
        timeToLive: (exit) => (Exit.isSuccess(exit) ? KEPT_FOR : Duration.zero),
      });

      return CallMembers.of({
        check: (instance, discord) =>
          Effect.gen(function* () {
            const kept = yield* Cache.get(heard, instance);
            if (kept.users.has(discord)) return "in" as const;
            // Not in an answer from before they came into the call, maybe: asked again, if it is old enough.
            const now = yield* Clock.currentTimeMillis;
            if (now - kept.at < ASKED_AGAIN_AFTER) return "out" as const;
            const fresh = yield* Cache.refresh(heard, instance);
            return fresh.users.has(discord) ? ("in" as const) : ("out" as const);
          }).pipe(Effect.catchTag("Unchecked", () => Effect.succeed("unchecked" as const))),
      });
    }),
  );
}
