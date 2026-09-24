// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The rib's static snapshot keys — one source of truth for the surface
// layout, the view declarations, and the recompose calls the tools make.
// One key per panel so each updates independently. The inspector has no
// region; it opens in the canvas drawer.
export const PULSE_KEY = "rib:beads:pulse";
export const WIP_KEY = "rib:beads:wip";
export const ATTENTION_KEY = "rib:beads:attention";
export const RECOMMEND_KEY = "rib:beads:recommend";
export const LADDERS_KEY = "rib:beads:ladders";
export const BACKLOG_KEY = "rib:beads:backlog";
export const SHIPPED_KEY = "rib:beads:shipped";
export const INSPECT_KEY = "rib:beads:inspect";

export const ALL_KEYS = [
  PULSE_KEY,
  WIP_KEY,
  ATTENTION_KEY,
  RECOMMEND_KEY,
  LADDERS_KEY,
  BACKLOG_KEY,
  SHIPPED_KEY,
  INSPECT_KEY,
] as const;

export const BEADS_SURFACE_ID = "beads";

// Retired keys, not registered anymore: the v0.1 mega-board, the
// finished-this-week strip, and the Plan, Portfolio and Momentum panels the
// Backlog, Epics and Shipped panels replaced.
export const BOARD_KEY = "rib:beads:board";
export const CLOSED_KEY = "rib:beads:closed";
export const PLAN_KEY = "rib:beads:plan";
export const PORTFOLIO_KEY = "rib:beads:portfolio";
export const MOMENTUM_KEY = "rib:beads:momentum";
