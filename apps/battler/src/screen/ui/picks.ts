import { portrait } from "@sequoia-leaf/figures/sprites.ts";
/**
 * Picks: three cards laid on the table to choose one from. The first figure to set out with, a
 * component after trouble, a boon now and then (with the one redraw); in the Wilds, after a boss,
 * one of two rules for the next five rooms, with the boss they end at beside them. Nothing else can
 * be done until the pick is made, so the cards sit over the board.
 */
import { link, thing } from "@sequoia-leaf/kit/card.ts";
import { add, el, icon } from "@sequoia-leaf/kit/dom.ts";
import {
  abilityShort,
  type BoonId,
  boonIn,
  boonShort,
  type Catalog,
  catalogOf,
  type Choice,
  type ComponentId,
  type FigureId,
  figureIn,
  isToolId,
  itemAdds,
  itemName,
  picksOf,
  pieces,
  roleLine,
  roomsFought,
  type RunView,
  type ToolId,
  TOOLS,
  traitIn,
  traitsOf,
} from "@sequoia-leaf/raid";

import { boonIcon, glyphPic, itemIcon, itemPic, traitIcon } from "../art/icons.ts";
import { fly } from "../fx.ts";
import { signal } from "../signals.ts";
import { snd } from "../sounds.ts";
import { boardSpot } from "../stage.ts";
import { ask, S } from "../state.ts";
import { boonRef, figureRef, itemRef, makesLines, pic, rich, traitRef } from "./cards.ts";
import { bossAhead, ruleCard } from "./rulecards.ts";
import { wantedBy } from "./suits.ts";
import { ruleTitle } from "./wilds.ts";

let key = "";

/** A pick's title, and under it only what the cards cannot show. */
const TITLES: Readonly<Record<Choice["kind"], readonly [string, string | null]>> = {
  starter: ["Who sets out with you?", null],
  component: ["Something from the room", "Two components make an item."],
  boon: ["A boon", "For the rest of the raid."],
  rule: ["A rule", "Both sides play by it."],
};
/** A pick's title and what is under it: a rule's says which rooms it is for. */
const titleOf = (run: RunView, choice: Choice): readonly [string, string | null] =>
  choice.kind === "rule" ? [ruleTitle(run.room), TITLES.rule[1]] : TITLES[choice.kind];

/** A picture on a pick that explains itself when pointed at; a tap on it chooses, as anywhere on the card. */
function art(c: HTMLCanvasElement, ref: string): HTMLElement {
  const box = el("span", "art", {}, pic(c, 3));
  link(box, ref, { acts: true });
  return box;
}

function starterCard(cat: Catalog, kind: FigureId): HTMLElement[] {
  const spec = figureIn(cat, kind);
  return [
    art(portrait(kind), figureRef(kind)),
    el("b", "k-gold", { text: spec.name }),
    el("div", "k-dim", { text: roleLine(cat, kind) }),
    el(
      "div",
      "k-wrap",
      {},
      ...traitsOf(cat, kind).map((t) => {
        const chip = el("span", "k-chip", {}, pic(traitIcon(t)), traitIn(cat, t).name);
        link(chip, traitRef(t), { acts: true });
        return chip;
      }),
    ),
    el("b", "", { text: spec.ability?.name ?? "" }),
    rich(abilityShort(cat, kind, 1)),
  ];
}
/**
 * A component on offer: what it adds, and what it makes with each of the others, as the other
 * half's picture, an arrow and the finished item. The ones whose other half the party already
 * holds come first, lit and tagged "have", so the pick that finishes an item is plain. Under its
 * name are the fielded figures that want anything it makes, and on each line the ones that want
 * that item.
 */
function componentCard(cat: Catalog, run: RunView, item: ComponentId): (HTMLElement | null)[] {
  const lines = makesLines(cat, item, run).map((line) =>
    el(
      "div",
      `makes${line.lit ? " lit" : ""}`,
      {},
      line.from ? thing(line.from, { bare: true }) : null,
      el("span", "k-dim", { text: "→" }),
      thing(line.ref, { ...(line.note ? { note: line.note } : {}), ...(line.tag ? { tag: line.tag } : {}) }),
    ),
  );
  return [
    art(itemIcon(item), itemRef(item)),
    el("b", "k-gold", { text: itemName(cat, item) }),
    rich(itemAdds(cat, item).join(" · ")),
    wantedBy(run, item),
    el("div", "makeslist", {}, ...lines),
  ];
}
/** A tool on offer among the components: its picture, its name and what it does. */
function toolCard(tool: ToolId): HTMLElement[] {
  return [
    art(itemIcon(tool), itemRef(tool)),
    el("b", "k-gold", { text: TOOLS[tool].name }),
    el("div", "k-dim", { text: "A tool" }),
    rich(TOOLS[tool].text),
  ];
}
function boonCardParts(cat: Catalog, boon: BoonId): HTMLElement[] {
  const spec = boonIn(cat, boon);
  return [
    art(boonIcon(cat, boon), boonRef(boon)),
    el("b", "k-gold", { text: spec.name }),
    el("div", "k-dim", { text: spec.sort === "charm" ? "A charm" : "A boon" }),
    rich(boonShort(cat, boon)),
  ];
}

/** What one of a pick's cards shows. */
function partsOf(run: RunView, choice: Choice, i: number): (HTMLElement | null)[] {
  switch (choice.kind) {
    case "starter":
      return starterCard(catalogOf(run), choice.options[i] ?? "rock");
    case "component": {
      const item = choice.options[i] ?? "thorn";
      return isToolId(item) ? toolCard(item) : componentCard(catalogOf(run), run, item);
    }
    case "boon":
      return boonCardParts(catalogOf(run), choice.options[i] ?? "windfall");
    case "rule":
      return ruleCard(choice.options[i] ?? "fog");
  }
}

/** Asks Leaf for three other boons. */
async function redrawn(button: Element | null): Promise<void> {
  if ((await ask({ do: "redraw" }, button))?.ok) snd.rustle();
}

/** Takes one of the cards: Leaf settles it, and what was taken goes where it lives. */
async function take(index: number, card: HTMLElement): Promise<void> {
  const run = S.run;
  const choice = run ? picksOf(run)[0] : undefined;
  if (!run || !choice) return;
  card.classList.add("chosen");
  const from = boardSpot(card);
  const done = await ask({ do: "choose", option: index }, card);
  if (!done?.ok) {
    card.classList.remove("chosen");
    return;
  }
  snd.choose();
  if (!from) return;
  const rack = (): { x: number; y: number } => boardSpot(document.getElementById("rack")) ?? from;
  for (const note of done.notes) {
    if (note.t === "component") fly(itemPic(note.item), from, rack(), { dur: 0.5, arc: 20, land: () => snd.give() });
    else if (note.t === "boon")
      fly(boonIcon(catalogOf(run), note.boon), from, rack(), { dur: 0.55, arc: 24, land: () => snd.give() });
    else if (note.t === "items") {
      note.items.forEach((item, i) =>
        fly(itemPic(item), from, rack(), { delay: 0.15 + i * 0.12, dur: 0.5, arc: 20, land: () => snd.give() }),
      );
    } else if (note.t === "acorns") {
      const purse = boardSpot(document.getElementById("acorns")) ?? from;
      for (let i = 0; i < note.amount; i++) {
        fly(glyphPic("acorn"), from, purse, {
          delay: 0.1 + i * 0.07,
          dur: 0.45,
          arc: 22,
          land: () => {
            snd.acorn(i);
            signal("acorn", 1);
          },
        });
      }
    }
  }
}

/** Puts the cards down to look at the table, or picks them up again; the pick still waits either way. */
function hideButton(box: HTMLElement): HTMLElement {
  const button = el("button", "k-btn blue sm", { type: "button", id: "pickhide" });
  const face = (down: boolean): void => button.replaceChildren(icon(down ? "up" : "down"), down ? "Show" : "Hide");
  face(false);
  button.addEventListener("click", () => {
    const down = !box.classList.contains("down");
    box.classList.toggle("down", down);
    face(down);
    snd.tap();
  });
  return button;
}

/** Shows the pick that is waiting, or puts the cards away. */
export function renderPicks(): void {
  const box = document.getElementById("picks");
  if (!box) return;
  const run = S.run;
  const choice = run && S.screen.at === "plan" ? picksOf(run)[0] : undefined;
  if (!run || !choice) {
    key = "";
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  // What the party holds too: a component's lines light the halves it already has.
  const held = `${JSON.stringify(run.rack)}|${pieces(run)
    .map((p) => p.items.join())
    .join(";")}`;
  const now = `${S.runs}:${roomsFought(run)}:${picksOf(run).length}:${choice.kind}:${choice.options.join()}:${held}`;
  if (now === key) return;
  key = now;
  box.hidden = false;
  box.classList.remove("down");
  box.dataset.kind = choice.kind;
  const [title, under] = titleOf(run, choice);
  const cards = el("div", "cards", {});
  choice.options.forEach((_, i) => {
    const card = el("button", "k-card pick k-rise", { type: "button", "data-pick": i });
    card.style.animationDelay = `${i * 70}ms`;
    add(card, ...partsOf(run, choice, i));
    card.addEventListener("click", () => void take(i, card));
    // Named by what it is; the links inside it stay stops, so a keyboard can read what each is before choosing.
    card.setAttribute("aria-label", card.querySelector(".k-gold")?.textContent ?? "");
    cards.append(card);
  });
  if (choice.kind === "rule") cards.append(bossAhead(run.room));
  const head = el(
    "div",
    "k-plaque head",
    {},
    el("b", "k-title", { text: title }),
    under ? el("span", "k-d", { text: under }) : null,
  );
  const again =
    choice.kind === "boon"
      ? el(
          "button",
          `k-btn wood sm${choice.redraws > 0 ? "" : " off"}`,
          {
            type: "button",
            id: "redraw",
            onclick: (e: Event) => void redrawn(e.currentTarget instanceof Element ? e.currentTarget : null),
          },
          choice.redraws > 0 ? "Show three others" : "No more to show",
        )
      : null;
  box.replaceChildren(head, cards, el("div", "k-row foot", {}, again, hideButton(box)));
  snd.card();
}
