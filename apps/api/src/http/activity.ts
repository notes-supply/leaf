/**
 * The raid in a Discord call. Discord frames the raid's page at `https://<client id>.discordsays.com`
 * and proxies every request it makes to Leaf. The page asks Discord to sign the player in
 * (`authorize`) and sends the code it gets to `POST /v1/activity/sign-in`. Leaf trades the code with
 * Discord, with the application's secret, for the player's token, reads who they are (`/users/@me`),
 * and signs them in as Discord sign-in does (`discordPlayer`): a Discord account Leaf knows is its
 * player, one it does not is a new one. The Leaf session's cookie is set for Discord's frame alone
 * (`frameCookie`). The answer is the token, which the page hands back to Discord (`authenticate`).
 * `GET /v1/activity` tells the page the application's client id, which `authorize` needs.
 */
import { Clock, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { SecureRandom } from "effect/crypto";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { SqlClient } from "effect/sql";

import { frameCookie, SignIns } from "../auth/sign-ins.ts";
import { askBackend, logFailure } from "../backend/failure.ts";
import { type Activity, AppConfig, DISCORD_API, fromLeafPage } from "../config.ts";
import { discordPlayer } from "../players/link.ts";
import type { Logins } from "../players/logins.ts";
import { DiscordId } from "../wire.ts";

/** How long Discord has to answer each question. */
const ASK_WITHIN = Duration.seconds(5);

/** What the page sends: the code Discord's `authorize` gave it. */
const Body = Schema.Struct({ code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)) });
/** What Discord answers a code with, of what Leaf reads. */
const Token = Schema.Struct({ access_token: Schema.String });
/** Who the token is, of what Leaf reads. */
const User = Schema.Struct({ id: DiscordId, username: Schema.String });

/** What a code came to: who signed in, with their token; a code Discord would not take; or no answer. */
type Traded =
  | { readonly status: "signed"; readonly token: string; readonly user: typeof User.Type }
  | { readonly status: "refused" };

const answer = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ code, message }, { status, headers: { "cache-control": "no-store" } });
const notFound = answer(404, "not_found", "No such route");

/**
 * Asks Discord one question within `ASK_WITHIN`: what `read` makes of a 2xx answer, none for one of
 * `refusedWith`'s statuses (Discord saying no), and a failure of the route `Discord <asked>` for
 * anything else, as a question to another of the guild's services fails (`askBackend`).
 */
const askDiscord = <A>(
  asked: string,
  request: HttpClientRequest.HttpClientRequest,
  refusedWith: readonly number[],
  read: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(HttpClientRequest.acceptJson(request)).pipe(
      Effect.flatMap((response) =>
        refusedWith.includes(response.status)
          ? Effect.succeed(Option.none<A>())
          : HttpClientResponse.filterStatusOk(response).pipe(Effect.flatMap(read), Effect.map(Option.some)),
      ),
      askBackend(`Discord ${asked}`, ASK_WITHIN),
    );
  });

/** Trades a code from the page for the player's token with Discord, and asks Discord who they are. */
const trade = (code: string, app: Activity) =>
  Effect.gen(function* () {
    const token = yield* askDiscord(
      "/oauth2/token",
      HttpClientRequest.post(`${DISCORD_API}/oauth2/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: app.clientId,
          client_secret: Redacted.value(app.clientSecret),
          grant_type: "authorization_code",
          code,
        }),
      ),
      // A code that is wrong, used, or another application's.
      [400, 401],
      HttpClientResponse.schemaBodyJson(Token),
    );
    if (Option.isNone(token)) return { status: "refused" } satisfies Traded;
    const accessToken = token.value.access_token;
    const user = yield* askDiscord(
      "/users/@me",
      HttpClientRequest.get(`${DISCORD_API}/users/@me`).pipe(HttpClientRequest.bearerToken(accessToken)),
      [401],
      HttpClientResponse.schemaBodyJson(User),
    );
    if (Option.isNone(user)) return { status: "refused" } satisfies Traded;
    return { status: "signed", token: accessToken, user: user.value } satisfies Traded;
  });

/** `POST /v1/activity/sign-in`, from the raid's page in a Discord call. */
const signIn = Effect.gen(function* () {
  const settings = yield* AppConfig;
  const app = settings.activity;
  if (app === undefined) return notFound;
  const request = yield* HttpServerRequest.HttpServerRequest;
  // Another site's page may not sign a browser in as someone it chose.
  if (!fromLeafPage(settings, request.headers["origin"])) {
    return answer(403, "bad_origin", "Leaf takes this only from its own pages");
  }
  const body = yield* HttpServerRequest.schemaBodyJson(Body).pipe(Effect.option);
  if (Option.isNone(body)) return answer(400, "invalid_code", 'Send { "code": "<the code Discord gave>" }');
  const traded = yield* trade(body.value.code, app).pipe(
    // Logged with the route and why alone: never the request, which holds the secret.
    Effect.catchTag("BackendFailure", (failure) =>
      Effect.as(logFailure("Discord could not be asked about a sign-in", failure), null),
    ),
  );
  if (traded === null) return answer(503, "discord_unavailable", "Discord did not answer. Try again shortly");
  if (traded.status === "refused") return answer(401, "discord_refused", "Discord did not sign you in. Try again");
  const { id, username } = traded.user;
  const now = yield* Clock.currentTimeMillis;
  const sql = yield* SqlClient.SqlClient;
  const playerId = yield* sql.withTransaction(discordPlayer(id, username, now)).pipe(Effect.orDie);
  const signIns = yield* SignIns;
  // Whether Sequoia's Discord calls them a member is the backend's to say; Leaf keeps what it said last.
  const member = yield* signIns.memberOf(id);
  const token = yield* signIns.begin({ playerId, discord: id, name: username, member }, now);
  const { name, options } = frameCookie(settings.publicOrigin);
  return HttpServerResponse.setCookieUnsafe(
    HttpServerResponse.jsonUnsafe({ access_token: traded.token }, { headers: { "cache-control": "no-store" } }),
    name,
    token,
    options,
  );
});

/** `GET /v1/activity`: the Discord application's client id, for the page's `authorize`. */
const hello = Effect.gen(function* () {
  const { activity } = yield* AppConfig;
  return activity === undefined ? notFound : HttpServerResponse.jsonUnsafe({ client_id: activity.clientId });
});

export const ActivityRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const needs = yield* Effect.context<
      AppConfig | SignIns | HttpClient.HttpClient | SecureRandom.SecureRandom | SqlClient.SqlClient | Logins
    >();
    yield* router.add("GET", "/v1/activity", Effect.provideContext(hello, needs));
    yield* router.add("POST", "/v1/activity/sign-in", Effect.provideContext(signIn, needs));
  }),
);
