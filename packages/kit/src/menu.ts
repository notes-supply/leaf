/**
 * The settings menu, the same in the town and in every game: opened from the gear in a page's
 * corner, or with Escape when there is nothing else for Escape to put away (the page decides that,
 * and calls `open`). It is a panel over the page, which is dimmed and still while it is up: nothing
 * behind it can be pressed, focused or read out (`inert`). It has a tab for each part:
 *
 * - Sound: the volume, sound on or off, and each kind of sound switched on or off on its own (the
 *   page's own kinds under its name, then those every game shares), each with a button to hear it.
 * - Keys: which keyboard the player has, and what each key does on this page, named as that
 *   keyboard prints it (`keyboard.ts`); the player may put another key in any slot but a few
 *   (`keystab.ts`).
 * - Account, where the page is live as somebody: how they signed in, whether a Wynncraft account is
 *   linked, and signing out (`account.ts`).
 * - Whatever tabs a page adds of its own (`MenuOf.tabs`).
 *
 * What it changes is the player's settings on this device (`settings.ts`), which every open page
 * follows at once; what the menu shows follows them too, whichever page changed them, and so does a
 * tip that is up, which may name a key. A page builds its menu once, at the start (`settingsMenu`).
 */
import { accountPage } from "./account.ts";
import { type Choices, choices } from "./choices.ts";
import { dialog } from "./dialog.ts";
import { el, icon } from "./dom.ts";
import { type KeyList, nameOf } from "./keyboard.ts";
import { KeysTab, shelf } from "./keystab.ts";
import { where } from "./live.ts";
import type { Scope } from "./scope.ts";
import { LOUDEST, type Settings, settings } from "./settings.ts";
import { sample, sfx, SHARED_SOUNDS, type SoundKind, unlock } from "./sound.ts";
import { retip, tip } from "./tip.ts";

/** Kinds of sound under one heading in the menu. */
export interface SoundShelf {
  readonly name: string;
  readonly sounds: readonly SoundKind[];
}

/**
 * A tab of the menu: its name, and what it shows, drawn each time it is chosen. `keep` holds what
 * the drawing listens to (a settings listener), let go of when it is drawn again or put away.
 */
export interface MenuTab {
  readonly id: string;
  readonly name: string;
  readonly draw: (keep: (stop: () => void) => void) => readonly HTMLElement[];
}

/** What a page tells its menu. */
export interface MenuOf {
  /** The page's own kinds of sound, by heading. The kinds every game shares come after them. */
  readonly sounds: readonly SoundShelf[];
  /** The page's keymap: the Keys tab is drawn from it. */
  readonly keys: KeyList;
  /** Tabs of the page's own, after Sound, Keys and Account. */
  readonly tabs?: readonly MenuTab[];
  /** Whether there is an Account tab where the page is live as somebody: not where Discord signed them in, in a call. */
  readonly account?: boolean;
  /** Told as the menu opens (true) and is put away (false): the page lets go of held keys and takes no play while it is open. */
  readonly opened?: (open: boolean) => void;
}

/** The menu of a page. */
export interface Menu {
  /** A gear for a corner of the page: it opens the menu, and puts it away. A page may have one on each of its screens. */
  gear(): HTMLElement;
  /** Opens the menu, at the tab of this id (`sound`, `keys`, `account`, or a page's own), or where it was last. */
  open(tab?: string): void;
  close(): void;
  readonly isOpen: boolean;
}

/** How often the volume slider sounds a tick while it is dragged, at most: often enough to hear the level, not a rattle. */
const TICK_MS = 160;

/** A switch: on or off, said as `name`, changed by a press. Gives back how to show it as it now is. */
function toggle(name: string, on: () => boolean, flip: (on: boolean) => void): [HTMLButtonElement, () => void] {
  const b = el("button", "k-switch", {
    type: "button",
    role: "switch",
    "aria-label": name,
    onclick: () => flip(!on()),
  });
  const paint = (): void => {
    b.setAttribute("aria-checked", String(on()));
  };
  paint();
  return [b, paint];
}

/** A row of the Sound tab for one kind of sound: a button to hear it, its name, and its switch. Gives back how to show it as the settings now are. */
function soundRow(kind: SoundKind): [HTMLElement, () => void] {
  const hear = el(
    "button",
    "k-btn wood icon sm",
    {
      type: "button",
      "aria-label": `Hear ${kind.name}`,
      onclick: () => {
        unlock();
        sample(kind.sample);
      },
    },
    icon("play"),
  );
  const on = (): boolean => !settings.now.quiet.has(kind.id);
  const [sw, paintSwitch] = toggle(kind.name, on, (next) => settings.setHeard(kind.id, next));
  const row = el("li", "k-card k-settings-sound", {}, hear, el("span", "k-name", { text: kind.name }), sw);
  const paint = (): void => {
    paintSwitch();
    row.classList.toggle("off", !on());
  };
  paint();
  return [row, paint];
}

/** The menu as a page has it: its panel over a page made still, its tabs, the tab shown, and what is held while it is open. */
class SettingsMenu implements Menu {
  readonly #of: MenuOf;
  readonly #tabsOf: readonly MenuTab[];
  /** The gears made for the page (`gear`): each says whether the menu is open. */
  readonly #gears = new Set<HTMLElement>();
  readonly #scrim = el("div", "k-scrim k-settings-scrim", { hidden: true });
  readonly #title = el("h2", "k-title", { text: "Settings" });
  // The page can take the keyboard, so a tab of nothing to press (Keys) can still be scrolled with it.
  readonly #page = el("div", "k-settings-page k-scroll", { tabindex: "0" });
  readonly #tabs: Choices<string>;
  readonly #keys: KeysTab;
  readonly #panel: HTMLElement;
  /** Listeners of the tab shown, let go of as it is drawn again or the menu is put away. */
  readonly #drops: (() => void)[] = [];
  /** What the menu made still behind it as it opened, to wake again as it is put away. */
  readonly #stilled: Element[] = [];
  #at: string;
  /** While open: what lets go of the menu's layer (`dialog`). */
  #put: (() => void) | null = null;
  #lastTick = 0;

  constructor(of: MenuOf, scope: Scope) {
    this.#of = of;
    this.#keys = new KeysTab(of.keys, () => {
      this.#cue();
    });
    const w = where();
    const account: MenuTab[] =
      w.mode === "live" && of.account !== false
        ? [{ id: "account", name: "Account", draw: () => accountPage(w.me, w.signIn) }]
        : [];
    this.#tabsOf = [
      { id: "sound", name: "Sound", draw: (keep) => this.#soundPage(keep) },
      { id: "keys", name: "Keys", draw: (keep) => this.#keys.draw(keep) },
      ...account,
      ...(of.tabs ?? []),
    ];
    this.#at = "sound";
    this.#tabs = choices(this.#tabsOf, {
      kind: "tabs",
      name: "Settings",
      chosen: this.#at,
      page: this.#page,
      choose: (id) => {
        this.#choose(id);
      },
    });
    const shut = el("button", "k-btn coral icon", { type: "button", "aria-label": "Close" }, icon("close"));
    this.#panel = el(
      "section",
      "k-panel k-settings",
      {},
      el("header", "k-head", {}, el("span", "k-settings-mark", {}, icon("gear")), this.#title, shut),
      this.#tabs.el,
      this.#keys.line,
      this.#page,
    );
    this.#scrim.append(this.#panel);
    document.body.append(this.#scrim);
    scope.on(shut, "click", () => {
      this.close();
    });
    // A press on the dimmed page around the panel puts it away; one inside it does not.
    scope.on(this.#scrim, "pointerdown", (e) => {
      if (e.target === this.#scrim) this.close();
    });
    // A press anywhere but on the slot waiting for a key stops it waiting, before it does what it does.
    scope.on(
      window,
      "pointerdown",
      (e) => {
        this.#keys.pressed(e.target);
      },
      { capture: true },
    );
    // A tip that is up names its key as it now is.
    scope.hold(of.keys.listen(retip));
    // The shade at the foot comes and goes as the tab scrolls, and as the window changes size.
    const cue = (): void => {
      this.#cue();
    };
    scope.on(this.#page, "scroll", cue);
    scope.on(window, "resize", cue);
    scope.on(window, "pagehide", () => {
      this.close();
    });
  }

  gear(): HTMLElement {
    const gear = el(
      "button",
      "k-btn wood icon",
      {
        type: "button",
        "aria-label": "Settings",
        "aria-expanded": String(this.#put !== null),
        onclick: () => {
          if (this.#put) this.close();
          else this.open();
        },
      },
      icon("gear"),
    );
    tip(gear, () => `Settings (${nameOf("Escape")})`);
    this.#gears.add(gear);
    return gear;
  }

  /** Tells every gear still on the page whether the menu is open; gears gone from the page are let go. */
  #tellGears(open: boolean): void {
    for (const gear of this.#gears) {
      if (gear.isConnected) gear.setAttribute("aria-expanded", String(open));
      else this.#gears.delete(gear);
    }
  }

  get isOpen(): boolean {
    return this.#put !== null;
  }

  open(tab: string = this.#at): void {
    if (this.#put) {
      this.#choose(tab);
      return;
    }
    this.#at = this.#tabsOf.some((t) => t.id === tab) ? tab : "sound";
    this.#still(true);
    this.#draw();
    this.#scrim.hidden = false;
    // The panel rises each time it opens.
    this.#panel.classList.remove("k-rise");
    void this.#panel.offsetWidth;
    this.#panel.classList.add("k-rise");
    this.#put = dialog(
      this.#panel,
      this.#title,
      () => {
        this.close();
      },
      (e) => this.#keys.take(e),
    );
    this.#tellGears(true);
    this.#cue();
    sfx.open();
    this.#of.opened?.(true);
  }

  close(): void {
    const done = this.#put;
    if (!done) return;
    this.#put = null;
    this.#letGo();
    this.#scrim.hidden = true;
    this.#tellGears(false);
    // Awake again before the focus goes back to what had it.
    this.#still(false);
    done();
    sfx.close();
    this.#of.opened?.(false);
  }

  /**
   * Makes everything on the page but the menu still (`inert`), or wakes what it made still: nothing
   * behind the menu can be pressed, take the keyboard or be read out while it is up. What is put on
   * the page while it is up, a notice that must be answered, is not made still.
   */
  #still(on: boolean): void {
    if (!on) {
      for (const node of this.#stilled.splice(0)) node.removeAttribute("inert");
      return;
    }
    for (const node of document.body.children)
      if (node !== this.#scrim && !node.hasAttribute("inert")) {
        node.setAttribute("inert", "");
        this.#stilled.push(node);
      }
  }

  #letGo(): void {
    for (const stop of this.#drops.splice(0)) stop();
  }

  #draw(): void {
    this.#letGo();
    this.#tabs.select(this.#at);
    const tab = this.#tabsOf.find((t) => t.id === this.#at) ?? this.#tabsOf[0];
    this.#keys.line.hidden = tab?.id !== "keys" || !this.#of.keys.changeable;
    this.#page.replaceChildren(...(tab?.draw((stop) => this.#drops.push(stop)) ?? []));
  }

  /** Another tab is chosen (from its row, `choices.ts`, or by `open`): drawn, from its top. */
  #choose(tab: string): void {
    if (tab === this.#at || !this.#tabsOf.some((t) => t.id === tab)) return;
    this.#at = tab;
    sfx.tap();
    this.#draw();
    this.#page.scrollTop = 0;
    this.#cue();
  }

  /** Whether there is more of the tab below what shows: a shade over the foot of the page says so. */
  #cue(): void {
    const p = this.#page;
    p.classList.toggle("more", p.scrollTop + p.clientHeight < p.scrollHeight - 2);
  }

  /** The Sound tab: the volume, then the page's kinds of sound and those every game shares, all shown as the settings now are, whichever page changes them. */
  #soundPage(keep: (stop: () => void) => void): HTMLElement[] {
    const [volume, paintVolume] = this.#volumeRow();
    const rows: [HTMLElement, () => void][] = [];
    const shelfOf = (name: string, kinds: readonly SoundKind[]): HTMLElement[] => {
      const made = kinds.map(soundRow);
      rows.push(...made);
      return shelf(
        name,
        made.map(([row]) => row),
      );
    };
    const out = [
      volume,
      ...this.#of.sounds.flatMap((s) => shelfOf(s.name, s.sounds)),
      ...shelfOf("Every game", SHARED_SOUNDS),
    ];
    keep(
      settings.listen((now) => {
        paintVolume(now);
        for (const [, paint] of rows) paint();
      }),
    );
    return out;
  }

  /** The volume: the speaker that turns the sound off and on, the slider, and the level as a number. Gives back how to show it as the settings now are. */
  #volumeRow(): [HTMLElement, (now: Settings) => void] {
    const speaker = el("button", "k-btn wood icon", {
      type: "button",
      "aria-label": "Sound on",
      onclick: () => {
        unlock();
        settings.setMuted(!settings.now.muted);
        if (!settings.now.muted) sample(() => sfx.tap());
      },
    });
    const slider = el("input", "k-slider", {
      type: "range",
      min: "0",
      max: String(LOUDEST),
      step: "1",
      "aria-label": "Volume",
      oninput: () => {
        unlock();
        settings.setVolume(Number(slider.value));
        this.#tick();
      },
    });
    const shown = el("output", "k-settings-percent", { "aria-hidden": "true" });
    const row = el(
      "div",
      "k-card k-settings-volume",
      {},
      speaker,
      el("label", "k-name k-settings-label", {}, "Volume", slider),
      shown,
    );
    const paint = (now: Settings): void => {
      speaker.replaceChildren(icon(now.muted ? "mute" : "sound"));
      speaker.setAttribute("aria-label", now.muted ? "Sound off" : "Sound on");
      speaker.setAttribute("aria-pressed", String(!now.muted));
      slider.style.setProperty("--v", `${now.volume}%`);
      slider.setAttribute("aria-valuetext", now.muted ? `${now.volume}%, sound off` : `${now.volume}%`);
      // Whoever moved it, the slider stands where the volume is: a key pressed on it moves on from there.
      if (slider.valueAsNumber !== now.volume) slider.value = String(now.volume);
      shown.textContent = now.muted ? "Off" : `${now.volume}%`;
      row.classList.toggle("muted", now.muted);
    };
    paint(settings.now);
    return [row, paint];
  }

  /** A tick as the volume slider moves, so the level is heard: no more often than `TICK_MS`. */
  #tick(): void {
    const now = performance.now();
    if (now - this.#lastTick < TICK_MS) return;
    this.#lastTick = now;
    sample(() => sfx.tap());
  }
}

/**
 * Makes the page's settings menu and its gear, and has the page follow the settings other pages
 * change (`settings.follow`), all for as long as `scope` stands. Call once, at the start.
 */
export function settingsMenu(of: MenuOf, scope: Scope): Menu {
  settings.follow(scope);
  return new SettingsMenu(of, scope);
}
