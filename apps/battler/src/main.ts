/**
 * The Little Raid: the guild's board-and-shop auto battler, played with carved figures on a hex
 * board cut into a great stump at the edge of Guild Town.
 *
 * This file only puts the parts together: the rules are `@sequoia-leaf/raid`, the table and
 * everything on it is in `screen/`. The table is Leaf's: the page opens it from the guild's server
 * and sends every move there as a command. Inside the town it says when it is ready, and sends news
 * worth a line in the town's feed. Opened by Discord in a call, it signs the player in through Discord
 * first, and is the call's table alone (`screen/call/`).
 */
import { nameOf } from "@sequoia-leaf/figures/sprites.ts";
import { refresh, settle } from "@sequoia-leaf/kit/card.ts";
import { keepLeaf, pageCard, serverCard, shutCard, start, troubleCard, type Where } from "@sequoia-leaf/kit/live.ts";
import { outside } from "@sequoia-leaf/kit/net.ts";
import { here } from "@sequoia-leaf/kit/presence.ts";
import { failedToOpen, watchPage } from "@sequoia-leaf/kit/report.ts";
import { type Scope, scope } from "@sequoia-leaf/kit/scope.ts";
import { fromTown, tell } from "@sequoia-leaf/kit/shell.ts";
import { fontsReady } from "@sequoia-leaf/kit/text.ts";
import { must } from "@sequoia-leaf/kit/util.ts";
import type { RaidNote, Way } from "@sequoia-leaf/raid";

import { LAUNCH } from "./screen/call/launch.ts";
import { openCallLine } from "./screen/call/line.ts";
import { signInToCall } from "./screen/call/signin.ts";
import { onTraitWoke } from "./screen/fightshow.ts";
import { stepFightView } from "./screen/fightview.ts";
import {
  carryOn,
  doHold,
  doLevelUp,
  doRustle,
  doSkip,
  doSpeed,
  goHome,
  leaveTable,
  lookBack,
  setOut,
  sitDown,
  startOn,
  toFront,
  traitOn,
  watchAgain,
} from "./screen/flow.ts";
import { stepFx } from "./screen/fx.ts";
import { openHand, unpick } from "./screen/hand.ts";
import { joinCall } from "./screen/live/listing.ts";
import { openLive } from "./screen/live/seat.ts";
import { openTables } from "./screen/live/tables.ts";
import { hearNotes, stepPawns, syncPawns } from "./screen/pawns.ts";
import { drawOver, drawScene, stepScene, wordsScene } from "./screen/scene.ts";
import { startSettings } from "./screen/settings.ts";
import { snd } from "./screen/sounds.ts";
import * as stage from "./screen/stage.ts";
import { catalogFor, onChange, onHeld, onNotes, onRefused, openTable, S } from "./screen/state.ts";
import { registerCards } from "./screen/ui/cards.ts";
import { onCarry, placeSheet, registerFought } from "./screen/ui/fightsheet.ts";
import { openLight } from "./screen/ui/lit.ts";
import { renderNudge, stepNudge } from "./screen/ui/nudge.ts";
import { meetMember } from "./screen/ui/own.ts";
import { openPages, pageOver, pagesClick, pageUp, renderPages, showPage } from "./screen/ui/pages.ts";
import { renderPicks } from "./screen/ui/picks.ts";
import { placeRack } from "./screen/ui/rackfold.ts";
import { placeRule, ruleSign, sayShifted } from "./screen/ui/rulecards.ts";
import { buildTable, placeFoe, renderTable, stepTable, toast, wakeChip } from "./screen/ui/table.ts";

/** What the page says where no Leaf answers: the table is the guild's server's. */
const NEEDS_LEAF = "The table needs the guild's server.";
/** What a call's page says when the browser did not keep the sign-in Discord gave it. */
const NOT_KEPT = "This browser did not keep your sign-in.";

/** The card of a call's page that will not open, and why: Try again opens it again. */
const callCard = (why: string): void => pageCard("The raid did not open", why, "Try again", () => outside.reload());

/**
 * Where the game is (`start()`), with the page watched; in a call, once Discord has signed the player
 * in, as the watch asks who they are as it starts. Null where the call's card says why the raid will
 * not open.
 */
async function signedIn(): Promise<Where | null> {
  const refused = LAUNCH ? await signInToCall() : null;
  watchPage("battler");
  const where = refused === null ? await start() : null;
  const kept = !(LAUNCH && where?.mode === "shut" && where.why === "signedout");
  if (where !== null && kept) return where;
  callCard(refused ?? NOT_KEPT);
  return null;
}

/** In a call: the call's table, sat at (or opened) at once, and its line for Discord's small picture. */
function openCall(tables: Scope): void {
  if (!LAUNCH) return;
  openCallLine(tables);
  void joinCall(LAUNCH.instance);
}

/**
 * The town is closing the table: it says where the member is from here, so the table says nothing
 * more of it (in case it would come after); and a pick in hand is put down.
 */
function closing(): void {
  here(null);
  unpick();
}

/** Whether the front page is up, and drawing it again if it is: for the live tables. */
const frontUp = (): boolean => pageUp() === "front";
function redrawFront(): void {
  if (frontUp()) renderPages(true);
}

/** Sets out from the front page, which goes once Leaf has laid the run out: on a trail, or on an endless run. */
async function setOutOn(way: Way): Promise<void> {
  if (await startOn(way)) showPage(null);
}

/** The member's first three-star figure ever is worth a line in the town. */
function tellFirstThreeStars(notes: readonly RaidNote[]): void {
  for (const note of notes) {
    const first = S.almanac.threeStars.length === 0 && S.run?.seen.threeStars.length === 1;
    if (note.t === "merged" && note.stars === 3 && first)
      tell({
        town: "news",
        text: `A first three-star figure at the stump: ${nameOf(catalogFor(S.run), note.kind)}.`,
        tone: "gold",
      });
  }
}
/** What the stage asks of the table each frame: its moving parts, its words, and the looks it is dressed in. */
const STAGE: stage.Hooks = {
  step(dt) {
    stepFx(dt);
    stepPawns();
    stepFightView(dt);
    stepScene(dt);
    stepTable();
    stepNudge();
  },
  draw: drawScene,
  words: wordsScene,
  over: drawOver,
  resized() {
    placeFoe();
    placeRack(S.run);
    placeRule();
    placeSheet();
    // The stall growing or shrinking lays the page out again too: a card stays beside its thing.
    settle();
    renderNudge();
  },
  looks: () => S.looks,
};

async function boot(): Promise<void> {
  await fontsReady();
  // Who the member is, and then the table as Leaf has it. Without Leaf there is no table.
  const where = await signedIn();
  if (where === null) return;
  if (where.mode === "shut") {
    shutCard(where.why);
    return;
  }
  if (where.mode !== "live") {
    serverCard(NEEDS_LEAF);
    return;
  }
  const trouble = await openTable(where.me.id, troubleCard);
  if (trouble) {
    failedToOpen(trouble);
    troubleCard(trouble);
    return;
  }
  const menu = startSettings(scope(), lookBack);
  registerCards();
  registerFought();
  // Who each banner's people are: their figures are nobody yet until Leaf has said, and as each banner opens.
  meetMember();
  onCarry(carryOn, lookBack);
  buildTable({
    rustle: () => void doRustle(),
    hold: doHold,
    levelUp: doLevelUp,
    setOut: () => void setOut(),
    speed: doSpeed,
    skipFight: doSkip,
    help: () => showPage("howto"),
    gear: () => menu.gear(),
    frontPage: toFront,
    lastFight: lookBack,
    traitOn,
  });
  // The Wilds' rule, while it holds: one line over the table.
  document.body.append(ruleSign());
  openPages({
    carryOn: (slot) => {
      showPage(null);
      sitDown(slot);
    },
    watch: (slot) => {
      showPage(null);
      watchAgain(slot);
    },
    setOut: (way) => void setOutOn(way),
    goHome: (slot) => void goHome(slot),
    leave: leaveTable,
    gear: () => menu.gear(),
  });
  document.getElementById("modal")?.addEventListener("click", pagesClick);
  // The live tables: the member's own, if they sit at one, and the Versus card's.
  const tables = scope();
  openLive(tables, { closePages: () => pageOver() && showPage(null), redrawFront, frontUp });
  openTables(tables, { id: where.me.id, name: where.me.name }, redrawFront);
  openCall(tables);

  // What the rules say happened is acted out by the figures, then the interface is drawn again.
  onNotes((notes) => {
    hearNotes(notes);
    tellFirstThreeStars(notes);
    sayShifted(notes);
  });
  onChange(() => {
    if (S.screen.at === "plan") syncPawns(S.run);
    renderTable();
    renderPicks();
    renderPages();
    renderNudge();
    // The card that is up says again what its thing is now (and goes, if the thing has gone).
    refresh();
  });
  onRefused((why) => {
    snd.no();
    toast(why);
  });
  // A tap or a drag while Leaf answers a rustle, a pick, setting out or the takings does nothing, and says so.
  onHeld(() => snd.no());
  onTraitWoke((trait) => wakeChip(trait));

  stage.open(STAGE);
  openHand(must(document.querySelector<HTMLCanvasElement>("#view"), "the table's canvas"));
  openLight();

  // A run in progress is offered again on the front page; nothing starts by itself.
  renderTable();
  renderPicks();
  renderPages();
  stage.layout();

  fromTown((msg) => {
    if (msg.town === "closing") closing();
  });
  here("table");
  // In the town, the town says when the member's Leaf changes; opened on its own, the table listens itself.
  keepLeaf();
  tell({ town: "ready" });
}

/** The table, opened and ready: what the tours' page (`review/index.html`) waits for before it opens its handle. */
export const booted: Promise<void> = boot();
