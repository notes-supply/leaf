import type { MinecraftId, PlayerId } from "@sequoia-leaf/core";
import { ENDLESS_WAYS } from "@sequoia-leaf/raid/content/endless.ts";
import { Context, type Redacted, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";

import type { DiscordId } from "../wire.ts";
import {
  BadOrigin,
  BodyTooLarge,
  GrantRefused,
  IdentityUnavailable,
  InternalError,
  Invalid,
  MembersOnly,
  Missing,
  NotAMember,
  NotYou,
  PurchaseRefused,
  Refused,
  RequestRefused,
  RequestsUnavailable,
  RequestUnknown,
  SlowDown,
  StaffOnly,
  StateUnreadable,
  Unauthorized,
} from "./errors.ts";
import {
  ActivityReport,
  Banners,
  CampLiked,
  Camps,
  CampVisitors,
  Events,
  GameMe,
  GrantBody,
  Granted,
  GuildEvents,
  Health,
  Hello,
  Me,
  PageErrorBody,
  Person,
  PlayBody,
  Played,
  PlayerLeaf,
  PlayShown,
  Png,
  PresenceBody,
  Present,
  PurchaseBody,
  PurchaseCancelled,
  Purchased,
  PurseBeside,
  Quests,
  RaidDepths,
  RaidHeld,
  Rates,
  RequestBody,
  RequestMade,
  Requests,
  RerollBody,
  Rerolled,
  Standings,
  Tally,
} from "./schemas.ts";
import {
  CallBody,
  OpenBody,
  SittingMissing,
  SittingPlayed,
  SittingRead,
  SittingRecord,
  SittingRefused,
  SittingShown,
  SittingsListed,
  SittingUpdating,
} from "./sittings.ts";

// Leaf's HTTP API, declared once: the server implements it, and its OpenAPI
// document (`/openapi.json`) is generated from it.

/** Who is making a request, as sequoia-backend vouches for them. */
export interface Identity {
  readonly playerId: PlayerId;
  /** The Minecraft account they signed in with, if they signed in with one. */
  readonly minecraft: MinecraftId | null;
  /** The Discord account they signed in with. */
  readonly discord: DiscordId | null;
  /** How they signed in: the website's session, or Leaf's own for Discord alone. */
  readonly via: "sequoia" | "discord";
  /** Whether the player has a Minecraft account now, however they signed in. */
  readonly linked: boolean;
  /** Whether they are to be asked to link a Wynncraft account: a member of the guild's Discord with none linked. */
  readonly askLink: boolean;
  readonly username: string;
  /** The player's rank in the guild, or null when they are not a member now. */
  readonly guildRank: string | null;
  readonly admin: boolean;
  /** The session they came with, to ask the backend something as them (`/v1/game/requests`). */
  readonly session: Redacted.Redacted;
}

export class CurrentIdentity extends Context.Service<CurrentIdentity, Identity>()("leaf/api/CurrentIdentity") {}

/**
 * Whether someone is in the game as a guest: signed in, but neither a member of the guild now nor a
 * website admin. Guests play, and spend their Leaf on what is for everyone, but have no XP, quests
 * or news of the guild's.
 */
export const isGuest = (identity: Identity): boolean => identity.guildRank === null && !identity.admin;

/**
 * The cookie the Sequoia website signs members in with. It is set for the whole
 * `seqwawa.com` domain, so browsers send it to Leaf too.
 */
export const SessionCookie = HttpApiSecurity.apiKey({ key: "seq_session", in: "cookie" });

/**
 * Lets in current guild members with a Sequoia session, the token
 * sequoia-backend issued, sent as `Authorization: Bearer` or as the website's
 * session cookie. Provides who they are.
 */
export class Session extends HttpApiMiddleware.Service<Session, { provides: CurrentIdentity }>()("leaf/api/Session", {
  security: { bearer: HttpApiSecurity.bearer, cookie: SessionCookie },
  error: [Unauthorized, NotAMember, BadOrigin, IdentityUnavailable],
}) {}

/**
 * Lets in anyone with a Sequoia session, member of the guild or not, checked as `Session` checks
 * it but without its gate. The game's routes take it; whoever is neither a member nor an admin
 * plays as a guest (`isGuest`).
 */
export class Player extends HttpApiMiddleware.Service<Player, { provides: CurrentIdentity }>()("leaf/api/Player", {
  security: { bearer: HttpApiSecurity.bearer, cookie: SessionCookie },
  error: [Unauthorized, BadOrigin, IdentityUnavailable],
}) {}

/** Answers a failure nothing expected with `internal_error`, after logging it. */
export class Unexpected extends HttpApiMiddleware.Service<Unexpected>()("leaf/api/Unexpected", {
  error: InternalError,
}) {}

/** Reads a request's body only up to 16 KiB: a longer one gets 413 `body_too_large` unread. */
export class BodyLimit extends HttpApiMiddleware.Service<BodyLimit>()("leaf/api/BodyLimit", {
  error: BodyTooLarge,
}) {}

/**
 * Lets in sequoia-backend, by the internal token the two share (`BACKEND_INTERNAL_TOKEN`, the
 * backend's `APP_INTERNAL_API_TOKEN`), sent as `Authorization: Bearer`, and only over the server's
 * private network: a request that came through the public proxy is refused, token or not.
 */
export class Backend extends HttpApiMiddleware.Service<Backend>()("leaf/api/Backend", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {}

/** Answers a purchase whose body is not `{ "player_id", "kind", "leaf" }` with `invalid_purchase`. */
export class PurchaseBodyErrors extends HttpApiMiddleware.Service<PurchaseBodyErrors>()("leaf/api/PurchaseBodyErrors", {
  error: Invalid,
}) {}

/** Answers a reroll whose body is not `{ "leaf": n }` with `invalid_cost`. */
export class RerollBodyErrors extends HttpApiMiddleware.Service<RerollBodyErrors>()("leaf/api/RerollBodyErrors", {
  error: Invalid,
}) {}

/** Answers a batch whose body is not `{ "commands": [...] }` with `invalid_command`. */
export class PlayBodyErrors extends HttpApiMiddleware.Service<PlayBodyErrors>()("leaf/api/PlayBodyErrors", {
  error: Invalid,
}) {}

/** Answers an opening of a sitting whose body is not `{ "player" }` with `invalid_command`. */
export class SittingBodyErrors extends HttpApiMiddleware.Service<SittingBodyErrors>()("leaf/api/SittingBodyErrors", {
  error: Invalid,
}) {}

/** Answers a guild request whose body is not an aspect, a tome or so many LE (`RequestBody`) with `invalid_request`. */
export class RequestBodyErrors extends HttpApiMiddleware.Service<RequestBodyErrors>()("leaf/api/RequestBodyErrors", {
  error: Invalid,
}) {}

/** Answers a staff grant whose body is not one (`GrantBody`) with `invalid_grant`. */
export class GrantBodyErrors extends HttpApiMiddleware.Service<GrantBodyErrors>()("leaf/api/GrantBodyErrors", {
  error: Invalid,
}) {}

/** Answers a page's report of its failure whose body is not one with `invalid_report`. */
export class PageErrorBodyErrors extends HttpApiMiddleware.Service<PageErrorBodyErrors>()(
  "leaf/api/PageErrorBodyErrors",
  {
    error: Invalid,
  },
) {}

/** Answers a presence whose body is not `{ "place" }` with one of the places with `invalid_place`. */
export class PresenceBodyErrors extends HttpApiMiddleware.Service<PresenceBodyErrors>()("leaf/api/PresenceBodyErrors", {
  error: Invalid,
}) {}

const EventPosition = { after: Schema.optional(Schema.String) };

const EventStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("healthz", "/healthz", { success: Health }),
) {}

/** What Leaf pays and costs, open to anyone: the website's guide to Leaf reads it. */
export class RatesApi extends HttpApiGroup.make("rates")
  .add(
    HttpApiEndpoint.get("rates", "/rates", {
      // The same until the next deploy: kept five minutes.
      success: HttpApiSchema.WithHeaders(Rates, { "cache-control": Schema.String }),
    }),
  )
  .prefix("/v1") {}

export class MeApi extends HttpApiGroup.make("me")
  .add(
    HttpApiEndpoint.get("account", "/", { success: Me }),
    HttpApiEndpoint.get("quests", "/quests", { query: { sync: Schema.optional(Schema.String) }, success: Quests }),
    HttpApiEndpoint.post("reroll", "/quests/:id/reroll", {
      params: { id: Schema.String },
      payload: RerollBody,
      success: HttpApiSchema.WithHeaders(Rerolled, PurseBeside),
      error: [Invalid, Refused],
    }).middleware(RerollBodyErrors),
    HttpApiEndpoint.get("events", "/events", { query: EventPosition, success: Events, error: Invalid }),
    HttpApiEndpoint.get("stream", "/events/stream", { query: EventPosition, success: EventStream, error: Invalid }),
  )
  .middleware(Session)
  .prefix("/v1/me") {}

/** The one game route open to anyone: the game asks it to learn whether it is on a live server. */
export class GameHelloApi extends HttpApiGroup.make("gameHello")
  .add(HttpApiEndpoint.get("hello", "/hello", { success: Hello }))
  .prefix("/v1/game") {}

/**
 * A page telling Leaf it failed (`PAGE_ERRORS_PATH`), from Leaf's own pages only, signed in or not: a
 * page that could not sign in says so too. Always answered 204, whether it was kept or let go of.
 */
export class GameReportsApi extends HttpApiGroup.make("gameReports")
  .add(
    HttpApiEndpoint.post("pageError", "/page-errors", {
      payload: PageErrorBody,
      error: [Invalid, BadOrigin],
    }).middleware(PageErrorBodyErrors),
  )
  .prefix("/v1/game") {}

const GameParams = { game: Schema.String };

// What only the browser game uses, open to anyone signed in, members and guests alike, but for the
// guild's own news, in six groups. Their answers are recorded in `contracts/game/`, a file a group of routes.

/** The player as the game knows them, other people (faces, cards), the banners, and the guild's news. */
export class GamePeopleApi extends HttpApiGroup.make("gamePeople")
  .add(
    HttpApiEndpoint.get("me", "/me", { success: GameMe }),
    HttpApiEndpoint.get("skin", "/skins/:uuid", {
      params: { uuid: Schema.String },
      success: Png,
      error: [Invalid, Missing],
    }),
    HttpApiEndpoint.get("guildEvents", "/guild/events", {
      query: EventPosition,
      success: GuildEvents,
      error: [Invalid, MembersOnly],
    }),
    HttpApiEndpoint.get("guildStream", "/guild/events/stream", {
      query: EventPosition,
      success: EventStream,
      error: [Invalid, MembersOnly],
    }),
    HttpApiEndpoint.get("person", "/people/:player", {
      params: { player: Schema.String },
      success: Person,
      error: Missing,
    }),
    HttpApiEndpoint.get("banners", "/banners", { success: Banners }),
  )
  .middleware(Player)
  .prefix("/v1/game") {}

/** Where in the game the player is, and who else is about. */
export class GamePresenceApi extends HttpApiGroup.make("gamePresence")
  .add(
    HttpApiEndpoint.put("presence", "/presence", {
      payload: PresenceBody,
      success: Present,
      error: Invalid,
    }).middleware(PresenceBodyErrors),
    HttpApiEndpoint.get("whoIsAbout", "/presence", { success: Present }),
  )
  .middleware(Player)
  .prefix("/v1/game") {}

/** The games Leaf plays: a player's state and commands, a visit and a board. */
export class GamePlayApi extends HttpApiGroup.make("gamePlay")
  .add(
    HttpApiEndpoint.get("play", "/play/:game", {
      params: GameParams,
      // From a page that found its copy of the state not Leaf's: the tick it found it at.
      query: { differs: Schema.optional(Schema.String) },
      success: PlayShown,
      error: [Missing, StateUnreadable],
    }),
    HttpApiEndpoint.post("command", "/play/:game", {
      params: GameParams,
      payload: PlayBody,
      success: Played,
      error: [Invalid, Missing, NotYou, StateUnreadable, SlowDown],
    }).middleware(PlayBodyErrors),
    HttpApiEndpoint.get("standings", "/play/:game/standings", {
      params: GameParams,
      success: Standings,
      error: Missing,
    }),
    HttpApiEndpoint.get("visit", "/play/:game/of/:player", {
      params: { ...GameParams, player: Schema.String },
      success: PlayShown,
      error: [Missing, StateUnreadable, SlowDown],
    }),
  )
  .middleware(Player)
  .prefix("/v1/game") {}

/** Whose figures an endless board is of: everyone's (by default), or the members' own, a board apart. */
const RaidPool = { pool: Schema.optional(Schema.Literals(["fair", "own"])) };

/**
 * The Little Raid's endless runs: an endless way's board of the deepest rooms won, for all time or
 * this week, and the rooms of the Deep Woods the caller holds this week; each of everyone's figures
 * unless `pool` says the members' own.
 */
export class GameRaidApi extends HttpApiGroup.make("gameRaid")
  .add(
    HttpApiEndpoint.get("depths", "/raid/depths/:way/:span", {
      params: { way: Schema.Literals(ENDLESS_WAYS), span: Schema.Literals(["ever", "week"]) },
      query: RaidPool,
      success: RaidDepths,
    }),
    HttpApiEndpoint.get("held", "/raid/held", { query: RaidPool, success: RaidHeld }),
  )
  .middleware(Player)
  .prefix("/v1/game") {}

const SittingParams = { id: Schema.String };

/**
 * The raid's sittings (its live tables): those open to sit at, opening one, one as the caller is
 * shown it (or unchanged since the `rev` the page has), commands at one, and the caller's record.
 */
export class GameSittingsApi extends HttpApiGroup.make("gameSittings")
  .add(
    HttpApiEndpoint.get("sittings", "/sittings", { success: SittingsListed }),
    HttpApiEndpoint.post("openSitting", "/sittings", {
      payload: OpenBody,
      success: SittingShown,
      error: [Invalid, NotYou, SittingRefused, SlowDown],
    }).middleware(SittingBodyErrors),
    HttpApiEndpoint.post("callSitting", "/sittings/call", {
      payload: CallBody,
      success: SittingShown,
      error: [Invalid, NotYou, SittingRefused, SittingUpdating, SlowDown],
    }).middleware(SittingBodyErrors),
    HttpApiEndpoint.get("sittingRecord", "/sittings/record", { success: SittingRecord }),
    HttpApiEndpoint.get("sitting", "/sittings/:id", {
      params: SittingParams,
      query: { rev: Schema.optional(Schema.String) },
      success: SittingRead,
      error: [SittingMissing, StateUnreadable, SittingUpdating],
    }),
    HttpApiEndpoint.post("sittingCommand", "/sittings/:id", {
      params: SittingParams,
      payload: PlayBody,
      success: SittingPlayed,
      error: [Invalid, NotYou, SittingMissing, StateUnreadable, SittingUpdating, SlowDown],
    }).middleware(PlayBodyErrors),
  )
  .middleware(Player)
  .prefix("/v1/game") {}

const CampParams = { player: Schema.String };

/** The camps: every one there is, likes given and taken back, and the caller's own camp's visitors. */
export class GameCampsApi extends HttpApiGroup.make("gameCamps")
  .add(
    HttpApiEndpoint.get("camps", "/camps", { success: Camps }),
    HttpApiEndpoint.get("visitors", "/camps/visitors", { success: CampVisitors }),
    HttpApiEndpoint.put("like", "/camps/:player/like", {
      params: CampParams,
      success: CampLiked,
      error: [Invalid, Missing, Refused, SlowDown],
    }),
    HttpApiEndpoint.delete("unlike", "/camps/:player/like", {
      params: CampParams,
      success: CampLiked,
      error: [Invalid, Missing, Refused, SlowDown],
    }),
  )
  .middleware(Player)
  .prefix("/v1/game") {}

/** The guild's requests a member may pay Leaf for. */
export class GameRequestsApi extends HttpApiGroup.make("gameRequests")
  .add(
    HttpApiEndpoint.get("requests", "/requests", {
      success: Requests,
      error: [MembersOnly, RequestRefused, RequestsUnavailable],
    }),
    HttpApiEndpoint.post("request", "/requests", {
      payload: RequestBody,
      success: HttpApiSchema.WithHeaders(RequestMade, PurseBeside),
      error: [Invalid, MembersOnly, RequestRefused, RequestsUnavailable, RequestUnknown],
    }).middleware(RequestBodyErrors),
  )
  .middleware(Player)
  .prefix("/v1/game") {}

/** The Tally's boards. */
export class GameTallyApi extends HttpApiGroup.make("gameTally")
  .add(
    HttpApiEndpoint.get("tally", "/tally/:board/:period", {
      params: { board: Schema.String, period: Schema.String },
      success: Tally,
      error: Missing,
    }),
  )
  .middleware(Player)
  .prefix("/v1/game") {}

/**
 * The staff's routes: signed in as the game's routes are, but only for a session the guild's
 * backend marks as a website admin. Nothing here is sent to any other player.
 */
export class GameAdminApi extends HttpApiGroup.make("gameAdmin")
  .add(
    HttpApiEndpoint.get("activity", "/activity", {
      query: { days: Schema.optional(Schema.String) },
      success: ActivityReport,
      error: [Invalid, StaffOnly],
    }),
    HttpApiEndpoint.post("grant", "/grants", {
      payload: GrantBody,
      success: Granted,
      error: [Invalid, StaffOnly, Missing, GrantRefused, StateUnreadable, SlowDown],
    }).middleware(GrantBodyErrors),
  )
  .middleware(Player)
  .prefix("/v1/game/admin") {}

const KeyParams = { key: Schema.String };

/**
 * sequoia-backend's routes: a member's Leaf, and the guild requests (tomes, aspects, LE) it buys for
 * them with it, each by a key of the backend's. Not for browsers or the mod.
 */
export class InternalApi extends HttpApiGroup.make("internal")
  .add(
    HttpApiEndpoint.get("leaf", "/players/:player/leaf", {
      params: { player: Schema.String },
      success: PlayerLeaf,
      error: Invalid,
    }),
    HttpApiEndpoint.put("buy", "/purchases/:key", {
      params: KeyParams,
      payload: PurchaseBody,
      success: Purchased,
      error: [Invalid, PurchaseRefused],
    }).middleware(PurchaseBodyErrors),
    HttpApiEndpoint.delete("cancel", "/purchases/:key", {
      params: KeyParams,
      success: PurchaseCancelled,
      error: Invalid,
    }),
  )
  .middleware(Backend)
  .prefix("/internal/v1") {}

export class LeafApi extends HttpApi.make("sequoia-leaf")
  .add(SystemApi)
  .add(RatesApi)
  .add(MeApi)
  .add(GameHelloApi)
  .add(GameReportsApi)
  .add(GamePeopleApi)
  .add(GamePresenceApi)
  .add(GamePlayApi)
  .add(GameRaidApi)
  .add(GameSittingsApi)
  .add(GameCampsApi)
  .add(GameRequestsApi)
  .add(GameTallyApi)
  .add(GameAdminApi)
  .add(InternalApi)
  .middleware(BodyLimit)
  .middleware(Unexpected)
  .annotateMerge(OpenApi.annotations({ title: "Leaf", description: "The Sequoia guild currency and its game" })) {}
