import { ByteSize, Clock, Effect, Layer, Option, Redacted } from "effect";
import { HttpServerError, HttpServerRequest } from "effect/http";
import { HttpApiBuilder, HttpApiError, HttpApiSecurity } from "effect/http-api";

import {
  BodyLimit,
  CurrentIdentity,
  GrantBodyErrors,
  type Identity,
  isGuest,
  PageErrorBodyErrors,
  PlayBodyErrors,
  Player,
  PresenceBodyErrors,
  RequestBodyErrors,
  RerollBodyErrors,
  Session,
  SessionCookie,
  Unexpected,
} from "../../api/api.ts";
import {
  BadOrigin,
  BodyTooLarge,
  IdentityUnavailable,
  InternalError,
  Invalid,
  NotAMember,
  Unauthorized,
} from "../../api/errors.ts";
import { Identities } from "../../auth/session.ts";
import { leafCookies, SignIns } from "../../auth/sign-ins.ts";
import { AppConfig, fromLeafPage } from "../../config.ts";
import { Logins } from "../../players/logins.ts";
import { RequestNote } from "../observe.ts";
import { cookieOf } from "../sign-in.ts";

/** The largest body Leaf reads. */
const MAX_BODY = ByteSize.kibibytes(16);

/** Methods that change nothing. Only these may come from another site's page with the session cookie. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * How many session cookies a `Cookie` header carries. A browser sends two
 * when another `seqwawa.com` site has set one of its own beside the website's.
 */
export function sessionCookies(header: string | undefined): number {
  return (header ?? "").split(/[;,]/).filter((pair) => pair.split("=", 1)[0]?.trim() === SessionCookie.key).length;
}

/** Leaf's own sessions, for players who signed in with Discord alone: the cookie, and who it is. */
const leafSessions = (signIns: SignIns["Service"], logins: Logins["Service"], publicOrigin: string) => {
  /** A Leaf session's cookie, for a player who signed in with Discord alone; "" when there is none. */
  const leafCookie = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return cookieOf(request.headers["cookie"], leafCookies(publicOrigin).session);
  });

  /** Who a Leaf session belongs to, while it lasts. */
  const admitLeaf = Effect.fnUntraced(function* (token: string) {
    const signedIn = yield* signIns.identify(token, yield* Clock.currentTimeMillis);
    if (Option.isNone(signedIn)) {
      return yield* new Unauthorized({ code: "unauthorized", message: "Your session has expired. Sign in again" });
    }
    // The player its Discord account is now: linking may have taken their first player into another.
    const { discord, name, member } = signedIn.value;
    const now = yield* logins.discordPlayer(discord);
    if (Option.isNone(now)) {
      return yield* new Unauthorized({ code: "unauthorized", message: "Your session has expired. Sign in again" });
    }
    const playerId = now.value;
    const linked = (yield* logins.minecraftOf([playerId])).has(playerId);
    const identity: Identity = {
      playerId,
      minecraft: null,
      discord,
      username: name,
      guildRank: null,
      admin: false,
      session: Redacted.make(token),
      via: "discord",
      linked,
      // Asked only while the player they are now has no Minecraft account: linked in another browser, not asked.
      askLink: member === true && !linked,
    };
    return identity;
  });

  return { leafCookie, admitLeaf };
};

/**
 * Who a request's session belongs to, for both ways in: `Session`, which lets in only current
 * guild members, and `Player`, which lets in anyone signed in. The session comes as a Bearer
 * header, as the mod sends it, or as the website's cookie, as a browser sends it to Leaf's own
 * pages; both are checked with the backend in the same way. A write that came with the cookie must
 * also come from one of Leaf's pages, by its `Origin`.
 *
 * Effect tries the Bearer header, then the cookie, lets the request in on the first that admits it,
 * and answers with the last refusal. So the cookie's turn, which comes last, is the one that
 * refuses: alone, either way of signing in is checked there. The Bearer's turn only lets in a
 * request that came with both: a Bearer that would let it in on its own wins, and otherwise the
 * cookie decides. A request with two session cookies is refused on both turns.
 */
export const sessionChecks = Effect.gen(function* () {
  const identities = yield* Identities;
  const signIns = yield* SignIns;
  const logins = yield* Logins;
  const settings = yield* AppConfig;
  const { publicOrigin } = settings;
  const bearerToken = HttpApiBuilder.securityDecode(HttpApiSecurity.bearer);
  const cookieToken = HttpApiBuilder.securityDecode(SessionCookie);

  // With two session cookies a browser could be signed in as someone another
  // site chose, so neither is believed, and neither is sent to the backend.
  const oneSessionCookie = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (sessionCookies(request.headers["cookie"]) > 1) {
      return yield* new Unauthorized({
        code: "unauthorized",
        message: "Your browser sent two Sequoia sessions. Sign in again",
      });
    }
  });

  /** Who a session belongs to, as the backend vouches. */
  const admit = Effect.fnUntraced(function* (token: string) {
    if (token === "") {
      return yield* new Unauthorized({ code: "unauthorized", message: "Sign in with your Sequoia account" });
    }
    const result = yield* identities.identify(token);
    if (result.status === "unauthorized") {
      return yield* new Unauthorized({ code: "unauthorized", message: "Your session has expired. Sign in again" });
    }
    if (result.status === "unavailable") {
      return yield* new IdentityUnavailable({
        code: "identity_unavailable",
        message: "Could not check your session. Try again shortly",
      });
    }
    return result.identity;
  });

  const { leafCookie, admitLeaf } = leafSessions(signIns, logins, publicOrigin);

  /**
   * The website's session, or, when the backend has refused it (signed out there, or linked
   * elsewhere), a Leaf session the same browser holds: one stale cookie does not hide a fresh one.
   */
  const admitEither = (cookie: string) =>
    admit(cookie).pipe(
      Effect.catchIf(
        (failure) => failure instanceof Unauthorized,
        (refused) => Effect.flatMap(leafCookie, (leaf) => (leaf === "" ? Effect.fail(refused) : admitLeaf(leaf))),
      ),
    );

  return {
    /** The Bearer's turn: only a request that also came with the cookie. */
    bearer: Effect.fnUntraced(function* (credential: Redacted.Redacted) {
      yield* oneSessionCookie;
      if (Redacted.value(yield* cookieToken) === "") {
        return yield* new Unauthorized({ code: "unauthorized", message: "Sign in with your Sequoia account" });
      }
      return yield* admit(Redacted.value(credential));
    }),
    /**
     * For a request that opens a live connection (`/v1/game/live`), which is a GET: the cookie, or
     * the Bearer when there is no cookie. A page on another site can open a WebSocket to Leaf, and
     * the browser sends the cookie with it, so with the cookie it must come from Leaf's own pages.
     */
    upgrade: Effect.gen(function* () {
      yield* oneSessionCookie;
      const cookie = Redacted.value(yield* cookieToken);
      const leaf = cookie === "" ? yield* leafCookie : "";
      if (cookie === "" && leaf === "") {
        return yield* admit(Redacted.value(yield* bearerToken));
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!fromLeafPage(settings, request.headers["origin"])) {
        return yield* new BadOrigin({ code: "bad_origin", message: "Leaf takes this only from its own pages" });
      }
      return cookie === "" ? yield* admitLeaf(leaf) : yield* admitEither(cookie);
    }),
    /** The cookie's turn: the cookie, or the Bearer when there is no cookie. */
    cookie: Effect.fnUntraced(function* (credential: Redacted.Redacted) {
      yield* oneSessionCookie;
      const cookie = Redacted.value(credential);
      // The website's session wins over Leaf's own: it is the member's, with their account and rank.
      const leaf = cookie === "" ? yield* leafCookie : "";
      if (cookie === "" && leaf === "") {
        return yield* admit(Redacted.value(yield* bearerToken));
      }
      // Another site's page can make a browser send the cookie, but not with Leaf's own origin.
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!SAFE_METHODS.has(request.method) && !fromLeafPage(settings, request.headers["origin"])) {
        return yield* new BadOrigin({ code: "bad_origin", message: "Leaf takes this only from its own pages" });
      }
      return cookie === "" ? yield* admitLeaf(leaf) : yield* admitEither(cookie);
    }),
  };
});

/** Lets a member through, and refuses anyone else; website admins count as members. */
const memberOnly = (identity: Identity) =>
  isGuest(identity)
    ? Effect.fail(new NotAMember({ code: "not_a_member", message: "Leaf is for current Sequoia members" }))
    : Effect.succeed(identity);

/** Lets in current guild members (and website admins) with a Sequoia session, and provides who they are. */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* () {
    const checks = yield* sessionChecks;
    return Session.of({
      bearer: (httpEffect, { credential }) =>
        checks.bearer(credential).pipe(
          Effect.flatMap(memberOnly),
          Effect.flatMap((identity) => Effect.provideService(httpEffect, CurrentIdentity, identity)),
        ),
      cookie: (httpEffect, { credential }) =>
        checks.cookie(credential).pipe(
          Effect.flatMap(memberOnly),
          Effect.flatMap((identity) => Effect.provideService(httpEffect, CurrentIdentity, identity)),
        ),
    });
  }),
);

/** Lets in anyone with a Sequoia session, member or guest, and provides who they are. */
export const PlayerLive = Layer.effect(
  Player,
  Effect.gen(function* () {
    const checks = yield* sessionChecks;
    return Player.of({
      bearer: (httpEffect, { credential }) =>
        checks
          .bearer(credential)
          .pipe(Effect.flatMap((identity) => Effect.provideService(httpEffect, CurrentIdentity, identity))),
      cookie: (httpEffect, { credential }) =>
        checks
          .cookie(credential)
          .pipe(Effect.flatMap((identity) => Effect.provideService(httpEffect, CurrentIdentity, identity))),
    });
  }),
);

/**
 * Answers a body that does not decode as the endpoint's payload with `invalid`, the endpoint's own
 * code and words saying what to send: the one shape of every body-error middleware.
 */
export const payloadError =
  (invalid: Invalid) =>
  <A, E, R>(httpEffect: Effect.Effect<A, E, R>) =>
    Effect.catchIf(
      httpEffect,
      (error) => HttpApiError.HttpApiSchemaError.is(error) && error.kind === "Payload",
      () => Effect.fail(invalid),
    );

/** A reroll whose body does not decode as `{ "leaf": n }` gets `invalid_cost`. */
export const RerollBodyErrorsLive = Layer.succeed(RerollBodyErrors)(
  payloadError(new Invalid({ code: "invalid_cost", message: 'Send the cost you agreed to as { "leaf": n }' })),
);

/**
 * A presence whose body is not `{ "place" }` (with one of the game's places, `camp_owner` a string,
 * and `stay` true or false, if any) gets `invalid_place`.
 */
export const PresenceBodyErrorsLive = Layer.succeed(PresenceBodyErrors)(
  payloadError(
    new Invalid({
      code: "invalid_place",
      message:
        'Send where you are as { "place": "town" }, or camp, works or table; at a camp "camp_owner" as its owner\'s UUID, "stay" as true or false, and "device" as phone or desktop',
    }),
  ),
);

/**
 * A guild request whose body is not `{ "type": "aspect" }`, `{ "type": "tome" }` (with `reason` a
 * string if any) or `{ "type": "le", "amount" }` (a whole number, 1 or more) gets `invalid_request`.
 */
export const RequestBodyErrorsLive = Layer.succeed(RequestBodyErrors)(
  payloadError(
    new Invalid({
      code: "invalid_request",
      message:
        'Send a request as { "type": "aspect" }, { "type": "tome", "reason": "<what it is for>" } or { "type": "le", "amount": <whole LE, 1 or more> }',
    }),
  ),
);

/** A staff grant whose body is not one (`GrantBody`) gets `invalid_grant`. */
export const GrantBodyErrorsLive = Layer.succeed(GrantBodyErrors)(
  payloadError(
    new Invalid({
      code: "invalid_grant",
      message:
        'Send { "player": "<Leaf id>", "figure": "<figure id>" } or "banner": "<banner id>" for its headliner, with "copies" 1 to 7 and "dry": true to see what it would do',
    }),
  ),
);

/** A page's report of its failure whose body is not one gets `invalid_report`. */
export const PageErrorBodyErrorsLive = Layer.succeed(PageErrorBodyErrors)(
  payloadError(
    new Invalid({
      code: "invalid_report",
      message: 'Send { "page", "kind", "version", "browser", "message", "stack" } as the kit\'s reporter does',
    }),
  ),
);

/** A batch whose body is not `{ "commands": [...] }` gets `invalid_command`. */
export const PlayBodyErrorsLive = Layer.succeed(PlayBodyErrors)(
  payloadError(
    new Invalid({
      code: "invalid_command",
      message: 'Send commands as { "player": "<your id>", "commands": [{ "id": "<yours>", ... }] }',
    }),
  ),
);

/** A body longer than the limit it was read under. Reading it is a defect, as every failure to read a body is. */
const isBodyTooLarge = (defect: unknown) =>
  HttpServerError.isHttpServerError(defect) &&
  defect.reason instanceof HttpServerError.RequestParseError &&
  defect.reason.reason === "BodyTooLarge";

/** A body is read only up to 16 KiB: one larger gets `body_too_large` unread. */
export const BodyLimitLive = Layer.succeed(BodyLimit)((httpEffect) =>
  httpEffect.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, MAX_BODY),
    Effect.catchDefect((defect) =>
      isBodyTooLarge(defect)
        ? Effect.fail(new BodyTooLarge({ code: "body_too_large", message: "Leaf reads a body of at most 16 KiB" }))
        : Effect.die(defect),
    ),
  ),
);

/**
 * Answers a defect, anything thrown rather than failed with a declared error, with `internal_error`;
 * the request's log line says what it was (`http/observe.ts`), or, outside a request, it is logged here.
 */
export const UnexpectedLive = Layer.succeed(Unexpected)((httpEffect) =>
  Effect.catchDefect(httpEffect, (defect) =>
    Effect.gen(function* () {
      const note = yield* RequestNote;
      if (note === null) yield* Effect.logError("An unexpected error answered 500", defect);
      else note.defect = Option.some(defect);
      return yield* new InternalError({ code: "internal_error", message: "Something went wrong" });
    }),
  ),
);
