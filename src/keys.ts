// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The rib's static snapshot keys — one source of truth for the surface
// layout, the view declarations, and the recompose calls the tools make.
// One key per panel so each spatial role updates independently: the pulse
// strip, the recommendation, the in-flight/attention pair, the Plan
// inventory, the selected-bead inspector, and the momentum strip.
export const PULSE_KEY = "rib:beads:pulse";
export const RECOMMEND_KEY = "rib:beads:recommend";
export const WIP_KEY = "rib:beads:wip";
export const ATTENTION_KEY = "rib:beads:attention";
export const PLAN_KEY = "rib:beads:plan";
export const INSPECT_KEY = "rib:beads:inspect";
export const CLOSED_KEY = "rib:beads:closed";

export const ALL_KEYS = [
  PULSE_KEY,
  RECOMMEND_KEY,
  WIP_KEY,
  ATTENTION_KEY,
  PLAN_KEY,
  INSPECT_KEY,
  CLOSED_KEY,
] as const;

// Kept for the tests and any external reference; the board surface id.
export const BEADS_SURFACE_ID = "beads";

// Retired: the single mega-board key (v0.1 layout). Not registered anymore.
export const BOARD_KEY = "rib:beads:board";
