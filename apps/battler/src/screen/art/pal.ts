/** The colours that mean something on the table: each trait, each component. The letters' colours are `@sequoia-leaf/figures`'. */
import { BARK, CORAL, CREAM, EARTH, GOLD, GREEN, LEAF, PAPER, SKY, STONE, WATER } from "@sequoia-leaf/kit/palette.ts";
import type { ComponentId } from "@sequoia-leaf/raid/content/items.ts";
import type { TraitId } from "@sequoia-leaf/raid/content/traits.ts";

/**
 * Each component's colour, its shade and its light (`RAID-BOARD.md` section 10). A finished item's
 * frame and its held tile are its two components' lights. No two lights are within ΔE 30 of each
 * other, nor two shades (`board.test.ts`).
 */
export const COMPONENT_TONE: Readonly<Record<ComponentId, { readonly shade: string; readonly light: string }>> = {
  thorn: { shade: "#b0483a", light: CORAL },
  plume: { shade: GOLD[0], light: GOLD[1] },
  glowcap: { shade: WATER[1], light: WATER[2] },
  bark: { shade: EARTH[0], light: EARTH[2] },
  chestnut: { shade: GREEN[2], light: GREEN[4] },
  // A stone blade with a cream edge: the only grey, and the only light near white.
  knife: { shade: STONE[2], light: CREAM },
};

/** A colour for each trait: its chip, its icon's ground, and what its abilities look like in the air. */
export const TRAIT_COLOUR: Readonly<Record<TraitId, string>> = {
  ember: CORAL,
  moss: GREEN[4],
  mist: WATER[3],
  burrow: EARTH[2],
  feather: "#e9d8b8",
  crab: "#b0483a",
  gnome: SKY[4],
  // The gold that ties the four raids' colours (its icon); each true form's ring is its raid's own.
  graid: GOLD[2],
  // Eggshell: what every Grooter creature wears a piece of.
  grooter: PAPER[2],
  // The pond in winter: the penguins' backs.
  huddle: WATER[2],
  // Russet: a red panda's, up the tree.
  canopy: BARK[3],
  // The badge's enamel: the town's blue glorp's, which no other trait wears.
  lhz: "#6fb0e8",
  bulwark: STONE[3],
  fang: "#f4a08c",
  slinger: GOLD[0],
  sage: SKY[3],
  mender: LEAF,
  sneak: SKY[2],
  chorus: "#e88fb4",
  greg: GREEN[3],
  rooted: GREEN[2],
  stowaway: BARK[4],
  // The stone of a tool's head.
  crafter: STONE[2],
};
