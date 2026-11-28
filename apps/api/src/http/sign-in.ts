import { Clock, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { SqlClient } from "effect/sql";

import { leafCookies, SIGN_IN_MS, SignIns } from "../auth/sign-ins.ts";
import { askBackend, logFailure } from "../backend/failure.ts";
import { AppConfig, fromLeafPage } from "../config.ts";
import { discordPlayer } from "../players/link.ts";
import type { Logins } from "../players/logins.ts";
import { DiscordId } from "../wire.ts";

/** How long a sign-in may take, from leaving for Discord to coming back, in seconds. */
const NONCE_SECONDS = 600;
const REDEEM_WITHIN = Duration.seconds(3);
/** Where a sign-in may come back to: one of the game's pages. */
const PAGE = /^\/play\/[A-Za-z0-9/_-]*$/;
const HOME = "/play/town/";

/** Who signed in with Discord, as the backend's one-time proof says. */
const Proof = Schema.Struct({
  discord_id: DiscordId,
  username: Schema.String,
  display_name: Schema.String,
  avatar: Schema.NullOr(Schema.String),
  return_to: Schema.String,
  sequoia_member: Schema.NullOr(Schema.Boolean),
});

/** A cookie's value in a `Cookie` header, or "" when it has none. */
export function cookieOf(header: string | undefined, name: string): string {
  for (const pair of (header ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return "";
}

/** The page a sign-in comes back to, with its query (`?of=`, `?camp=`): one of the game's own, or the town. */
const pageOf = (to: string | null, origin: string): string => {
  const page = to === null || !to.startsWith("/") ? null : URL.parse(to, origin);
  return page !== null && page.origin === origin && PAGE.test(page.pathname) && !page.pathname.includes("//")
    ? `${page.pathname}${page.search}`
    : HOME;
};

/**
 * Signing in with Discord, for everyone. `GET /v1/game/sign-in?to=<page>` sends the browser to the
 * guild's sign-in, which goes on to Discord, with a nonce in a cookie of Leaf's. A Discord account
 * with a Minecraft account linked comes back signed in to the website, as members always have; one
 * without comes back with a one-time proof, which `GET /v1/game/sign-in/back` redeems with the
 * backend, checks against the nonce, and turns into a Leaf session for the player that Discord
 * account is (`discordPlayer`). Either way the browser goes back to the page. `POST
 * /v1/game/sign-out`, from Leaf's own pages, ends the Leaf session.
 */
type Cookie = readonly [name: string, value: string, seconds: number];

/** Back to the page, setting these cookies; one with no time left is taken away. */
const back = (to: string, cookies: readonly Cookie[], secure: boolean) =>
  cookies.reduce(
    (response, [name, value, seconds]) =>
      seconds > 0
        ? HttpServerResponse.setCookieUnsafe(response, name, value, {
            path: "/",
            httpOnly: true,
            sameSite: "lax",
            secure,
            maxAge: Duration.seconds(seconds),
          })
        : HttpServerResponse.expireCookieUnsafe(response, name, { path: "/", secure }),
    HttpServerResponse.redirect(to, { status: 302, headers: { "cache-control": "no-store" } }),
  );

/** Redeems a one-time Discord proof with the backend: who signed in, or none when it will not say. */
const redeem = Effect.fnUntraced(function* (code: string) {
  const { backendUrl, backendToken } = yield* AppConfig;
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(
      HttpClientRequest.get(new URL(`/internal/leaf/discord-proofs/${encodeURIComponent(code)}`, backendUrl)).pipe(
        HttpClientRequest.bearerToken(backendToken === undefined ? "" : Redacted.value(backendToken)),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Proof)),
      askBackend("/internal/leaf/discord-proofs", REDEEM_WITHIN),
      Effect.map(Option.some),
      Effect.catchTag("BackendFailure", (failure) =>
        Effect.as(logFailure("A Discord sign-in could not be redeemed", failure), Option.none()),
      ),
    );
});

/** `GET /v1/game/sign-in`: off to the guild's sign-in, with a nonce for the way back. */
const begin = Effect.gen(function* () {
  const { gameSignInUrl, publicOrigin } = yield* AppConfig;
  const cookies = leafCookies(publicOrigin);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const to = pageOf(new URL(request.url, publicOrigin).searchParams.get("to"), publicOrigin);
  const nonce = Buffer.from(yield* (yield* SecureRandom.SecureRandom).randomBytes(18)).toString("base64url");
  const returnTo = `${publicOrigin}/v1/game/sign-in/back?to=${encodeURIComponent(to)}&n=${nonce}`;
  return back(
    `${gameSignInUrl}${encodeURIComponent(returnTo)}&allow_unlinked=true`,
    [[cookies.nonce, nonce, NONCE_SECONDS]],
    cookies.secure,
  );
});

/** `GET /v1/game/sign-in/back`: back from Discord, with a proof to redeem or none. */
const cameBack = Effect.gen(function* () {
  const { publicOrigin } = yield* AppConfig;
  const { secure, session, nonce: nonceCookie } = leafCookies(publicOrigin);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const query = new URL(request.url, publicOrigin).searchParams;
  const to = pageOf(query.get("to"), publicOrigin);
  const forgetNonce: Cookie = [nonceCookie, "", 0];
  const code = query.get("leaf_discord");
  // Signed in to the website (a member with an account linked), or not signed in: back to the page.
  if (code === null) return back(to, [forgetNonce], secure);
  const nonce = cookieOf(request.headers["cookie"], nonceCookie);
  const proof = Option.getOrUndefined(yield* redeem(code));
  const returned = proof === undefined ? null : URL.parse(proof.return_to);
  // The proof must have been asked for by this browser, for this page, from Leaf.
  if (
    proof === undefined ||
    nonce === "" ||
    query.get("n") !== nonce ||
    returned?.origin !== publicOrigin ||
    returned.searchParams.get("n") !== nonce
  ) {
    return back(to, [forgetNonce], secure);
  }
  const now = yield* Clock.currentTimeMillis;
  const sql = yield* SqlClient.SqlClient;
  const playerId = yield* sql.withTransaction(discordPlayer(proof.discord_id, proof.username, now)).pipe(Effect.orDie);
  const token = yield* (yield* SignIns).begin(
    { playerId, discord: proof.discord_id, name: proof.username, member: proof.sequoia_member },
    now,
  );
  return back(to, [forgetNonce, [session, token, SIGN_IN_MS / 1000]], secure);
});

/** `POST /v1/game/sign-out`, from Leaf's own pages: ends the Leaf session. */
const signOut = Effect.gen(function* () {
  const settings = yield* AppConfig;
  const { publicOrigin } = settings;
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!fromLeafPage(settings, request.headers["origin"])) {
    return HttpServerResponse.jsonUnsafe(
      { code: "bad_origin", message: "Leaf takes this only from its own pages" },
      { status: 403 },
    );
  }
  const { secure, session } = leafCookies(publicOrigin);
  const token = cookieOf(request.headers["cookie"], session);
  if (token !== "") yield* (yield* SignIns).end(token);
  return HttpServerResponse.expireCookieUnsafe(HttpServerResponse.empty({ status: 204 }), session, {
    path: "/",
    secure,
  });
});

export const SignInRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const needs = yield* Effect.context<
      AppConfig | SignIns | HttpClient.HttpClient | SecureRandom.SecureRandom | SqlClient.SqlClient | Logins
    >();
    yield* router.add("GET", "/v1/game/sign-in", Effect.provideContext(begin, needs));
    yield* router.add("GET", "/v1/game/sign-in/back", Effect.provideContext(cameBack, needs));
    yield* router.add("POST", "/v1/game/sign-out", Effect.provideContext(signOut, needs));
  }),
);
