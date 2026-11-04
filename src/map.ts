// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The epic wave map: one block per open epic, its open children laid out in
// wave columns with the blocking edges drawn between them. It is an `html`
// region because the host's board blocks cannot draw an edge. The markup is
// a pure function of the measurement: selection lives in the frame, so a
// click never changes the fragment and never reloads it.

import { bdFloorLabel } from "./bd";
import {
  clampTitle,
  commonPriority,
  type EpicLane,
  type EpicNode,
  type EpicView,
  epicViews,
  shortId,
  stageSplit,
} from "./board";
import { bdBelowFloor, type ProjectMeasurement } from "./measure";
import type { LiveRun } from "./runs";

const DONE_LISTED = 12;

const LANE_LABEL: Record<EpicLane, string> = {
  working: "in flight",
  review: "in review",
  ready: "ready",
  waiting: "waiting",
  hold: "on hold",
};

// Bead titles and ids are tracker text, so every interpolation is escaped.
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Keelson's palette, dark first like the SPA. Hosts stamp the operator's live
// palette as --keelson-<token> and data-theme on the root; the hex values are
// the fallback for an older host.
const t = (token: string, fallback: string) => `var(--keelson-${token},${fallback})`;
const STYLE = `
:root{--card:${t("card", "#161e3b")};--card-2:${t("card-2", "#1f2a4d")};--border:${t("border", "#2a3258")};
--fg:${t("fg", "#d8def0")};--fg-strong:${t("fg-strong", "#f0f3ff")};--muted:${t("muted", "#8993b2")};
--accent:${t("accent", "#9b8eff")};--good:${t("green", "#6dd28d")};--warn:${t("yellow", "#f5c352")};
--crit:${t("red", "#f08793")};--info:${t("cyan", "#7cc0ff")};
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
--line:color-mix(in srgb,var(--border) 85%,transparent);--well:var(--card-2);
--chip:color-mix(in srgb,var(--card-2) 38%,var(--card));color-scheme:dark}
:root[data-theme="light"]{--card:${t("card", "#ffffff")};--card-2:${t("card-2", "#eeeaf7")};--border:${t("border", "#c8bfdc")};
--fg:${t("fg", "#161b31")};--fg-strong:${t("fg-strong", "#0b0f1e")};--muted:${t("muted", "#5d5876")};
--accent:${t("accent", "#6d4fe0")};--good:${t("green", "#15834f")};--warn:${t("yellow", "#b57a00")};
--crit:${t("red", "#d9385e")};--info:${t("cyan", "#2e6fd8")};
--chip:color-mix(in srgb,var(--card-2) 45%,var(--card));color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:10px 12px 14px;background:var(--card);color:var(--fg);font:13px/1.45 var(--sans);-webkit-font-smoothing:antialiased}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin:0 0 16px;font-size:12px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend .hint{margin-left:auto}
.epic+.epic{margin-top:26px;padding-top:22px;border-top:1px solid var(--line)}
.head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 20px}
.ttl{display:flex;align-items:baseline;gap:10px;min-width:0}
.ttl button{font:600 15px/1.3 var(--sans);color:var(--fg-strong);background:none;border:0;padding:0;cursor:pointer;text-align:left}
.ttl button:hover{color:var(--accent)}
.eid{font:11.5px var(--mono);color:var(--muted)}
.facts{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.facts span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.facts b{font-weight:600;color:var(--fg-strong)}
.facts .flag{color:var(--warn);font-weight:600}
.meter{display:flex;gap:2px;height:6px;border-radius:999px;overflow:hidden;background:var(--well);margin:10px 0 0}
.meter i{display:block;height:100%}
.m-done{background:var(--good)}.m-review{background:color-mix(in srgb,var(--accent) 55%,var(--card))}.m-working{background:var(--info)}
.m-ready{background:var(--accent)}.m-waiting{background:color-mix(in srgb,var(--muted) 40%,var(--well))}
.donelist{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--muted)}
.donelist .lbl{display:inline-flex;align-items:center;gap:6px;margin-right:2px}
.donelist button{font:11.5px var(--mono);color:var(--fg);background:var(--well);border:0;border-radius:999px;padding:1px 8px;cursor:pointer}
.donelist button:hover{color:var(--accent)}
.scroll{overflow-x:auto;margin-top:14px;padding:2px}
.waves{position:relative;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(210px,300px);gap:8px 56px;align-items:start;justify-content:start}
.waves svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.waves path{fill:none;stroke:var(--muted);stroke-width:1.5;opacity:.75;marker-end:url(#ah)}
.waves path.hot{stroke:var(--accent);stroke-width:2;opacity:1;marker-end:url(#ah-hot)}
.waves.lit path:not(.hot){opacity:.1}
.waves marker path{stroke:none;opacity:1!important;marker-end:none}
.wave{display:flex;flex-direction:column;gap:6px;position:relative;z-index:1;min-width:0}
.wave h3{margin:0 0 2px;font:600 12px var(--sans);color:var(--fg)}
.wave h3 span{font-weight:400;color:var(--muted)}
.chip{display:block;width:100%;text-align:left;font:inherit;color:var(--fg);background:var(--chip);border:1px solid var(--line);border-radius:10px;padding:8px 11px 9px;cursor:pointer}
.chip:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.chip .top{display:flex;align-items:center;gap:7px;font:11.5px var(--mono);color:var(--muted)}
.chip .tags{margin-left:auto;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}
.chip .t{display:block;margin-top:4px;line-height:1.35;color:var(--fg-strong)}
.chip .w{display:block;margin-top:4px;font-size:12px;color:var(--muted)}
.chip .w.edge{display:none}
.chip.working{box-shadow:inset 3px 0 0 var(--info)}.chip.review{box-shadow:inset 3px 0 0 color-mix(in srgb,var(--accent) 60%,var(--card))}
.chip.waiting,.chip.hold{background:transparent;border-color:color-mix(in srgb,var(--muted) 40%,var(--line))}
.chip.waiting .t,.chip.hold .t{color:color-mix(in srgb,var(--fg) 92%,var(--card))}
.chip.hold{border-style:dashed}
.chip.run{border-color:color-mix(in srgb,var(--info) 70%,transparent)}
.chip.gate{border-color:color-mix(in srgb,var(--warn) 80%,transparent);box-shadow:inset 3px 0 0 var(--warn)}
.chip.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.chip.working.sel{box-shadow:inset 3px 0 0 var(--info),0 0 0 1px var(--accent)}
.waves.lit .chip:not(.on){opacity:.35}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block}
.dot.done{background:var(--good)}
.dot.working{background:linear-gradient(90deg,var(--info) 50%,transparent 50%);border:1.5px solid var(--info)}
.dot.review{background:color-mix(in srgb,var(--accent) 55%,var(--card));border:1.5px solid var(--accent)}.dot.ready{background:var(--accent)}
.dot.waiting{border:1.5px solid var(--muted)}.dot.hold{border:1.5px dashed var(--muted)}
.tag{--c:var(--muted);font:600 11px/1.5 var(--sans);padding:0 7px;border-radius:999px;white-space:nowrap;color:color-mix(in srgb,var(--c) 85%,var(--fg-strong));background:color-mix(in srgb,var(--c) 16%,transparent)}
.tag.next{--c:var(--accent)}.tag.you{--c:var(--warn)}.tag.run{--c:var(--info)}
.tag.p{--c:var(--warn)}.tag.p0{--c:var(--crit)}
:root[data-theme="light"] .tag{color:color-mix(in srgb,var(--c) 88%,#000)}
.alarm{border:1px solid color-mix(in srgb,var(--crit) 55%,var(--line));background:color-mix(in srgb,var(--crit) 7%,var(--card));border-radius:10px;padding:10px 12px;margin-bottom:12px}
.alarm b{color:var(--crit);font:600 11px var(--mono);letter-spacing:.06em;margin-right:8px}
.alarm pre{margin:6px 0 0;font:11.5px var(--mono);color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:720px){.waves{grid-auto-flow:row;grid-auto-columns:auto;grid-template-columns:minmax(0,1fr);justify-content:stretch;min-width:0!important;gap:14px}
.waves svg{display:none}.chip .w.edge{display:block}.legend .hint{display:none}}
@media (prefers-reduced-motion:no-preference){.chip{transition:opacity .12s,border-color .12s}}
`;

// Draws one curve per blocking edge, lights a bead's chain on hover or focus,
// and posts select-bead (the one verb the rib honours from a frame).
const SCRIPT = `
(function(){
  var DEFS='<defs>'+[["ah","var(--muted)"],["ah-hot","var(--accent)"]].map(function(m){
    return '<marker id="'+m[0]+'" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" style="fill:'+m[1]+'"/></marker>';
  }).join("")+'</defs>';
  var sel=null;
  document.querySelectorAll(".waves").forEach(function(map){
    var svg=map.querySelector("svg"),chips=Object.create(null),edges=[];
    map.querySelectorAll(".chip").forEach(function(c){chips[c.dataset.id]=c;});
    var deps=Object.create(null),outs=Object.create(null);
    Object.keys(chips).forEach(function(id){
      deps[id]=(chips[id].dataset.deps||"").split(" ").filter(function(d){return chips[d];});
      deps[id].forEach(function(d){(outs[d]=outs[d]||[]).push(id);});
    });
    function walk(id,rel,acc){(rel[id]||[]).forEach(function(n){if(!acc[n]){acc[n]=1;walk(n,rel,acc);}});return acc;}
    var cols=[].slice.call(map.querySelectorAll(".wave")),colOf=Object.create(null);
    cols.forEach(function(w,i){w.querySelectorAll(".chip").forEach(function(c){colOf[c.dataset.id]=i;});});
    function seg(x1,y1,x2,y2){var dx=Math.min(40,(x2-x1)/2);return " C"+(x1+dx)+" "+y1+","+(x2-dx)+" "+y2+","+x2+" "+y2;}
    // An edge that skips a column threads the gap between that column's
    // chips nearest its line, so it never passes behind an unrelated bead.
    function lane(w,r,want){
      var ys=[],cs=[].slice.call(w.querySelectorAll(".chip")).map(function(c){return c.getBoundingClientRect();});
      for(var i=0;i+1<cs.length;i++)ys.push((cs[i].bottom+cs[i+1].top)/2-r.top);
      var last=cs[cs.length-1];
      if(last&&last.bottom-r.top+12<=r.height)ys.push(last.bottom-r.top+12);
      if(!ys.length)return want;
      return ys.reduce(function(b,y){return Math.abs(y-want)<Math.abs(b-want)?y:b;});
    }
    function draw(){
      var r=map.getBoundingClientRect();svg.innerHTML=DEFS;edges=[];
      Object.keys(deps).forEach(function(id){
        var z=chips[id].getBoundingClientRect(),n=deps[id].length;
        // Edges into one chip land spread top to bottom, so a fan-in reads as separate lines.
        deps[id].slice().sort(function(p,q){return chips[p].getBoundingClientRect().top-chips[q].getBoundingClientRect().top;}).forEach(function(d,j){
        var a=chips[d].getBoundingClientRect(),gap=Math.min(7,z.height/(n+1));
        var x=a.right-r.left,y=a.top+a.height/2-r.top,x2=z.left-r.left,y2=z.top+z.height/2-r.top+(j-(n-1)/2)*gap;
        var path="M"+x+" "+y,ca=colOf[d],cb=colOf[id];
        for(var k=ca+1;k<cb;k++){
          var c=cols[k].getBoundingClientRect(),l=c.left-r.left,rt=c.right-r.left;
          var ly=lane(cols[k],r,y+(y2-y)*(l-x)/Math.max(1,x2-x));
          path+=seg(x,y,l,ly)+" L"+rt+" "+ly;x=rt;y=ly;
        }
        path+=seg(x,y,x2,y2);
        var p=document.createElementNS("http://www.w3.org/2000/svg","path");
        p.setAttribute("d",path);
        svg.appendChild(p);edges.push({from:d,to:id,el:p});
      });});
      if(map.dataset.lit)light(map.dataset.lit);
    }
    function light(id){
      var up=walk(id,deps,{}),down=walk(id,outs,{});
      map.dataset.lit=id;map.classList.add("lit");
      Object.keys(chips).forEach(function(k){chips[k].classList.toggle("on",k===id||!!up[k]||!!down[k]);});
      edges.forEach(function(e){
        var on=((e.to===id||up[e.to])&&up[e.from])||((e.from===id||down[e.from])&&down[e.to]);
        e.el.classList.toggle("hot",!!on);
      });
    }
    function rest(){
      if(sel&&chips[sel]){light(sel);return;}
      delete map.dataset.lit;map.classList.remove("lit");
      edges.forEach(function(e){e.el.classList.remove("hot");});
    }
    Object.keys(chips).forEach(function(id){
      var c=chips[id];
      c.addEventListener("mouseenter",function(){light(id);});
      c.addEventListener("focus",function(){light(id);});
      c.addEventListener("mouseleave",rest);
      c.addEventListener("blur",rest);
    });
    map._rest=rest;
    draw();
    if(typeof ResizeObserver==="function")new ResizeObserver(draw).observe(map);
    else window.addEventListener("resize",draw);
  });
  function mark(id){
    sel=id;
    document.querySelectorAll(".chip").forEach(function(c){c.classList.toggle("sel",c.dataset.id===sel);});
    document.querySelectorAll(".waves").forEach(function(m){m._rest();});
  }
  // Clearing is local: the rib honours only select-bead from a frame.
  document.addEventListener("click",function(e){
    var b=e.target&&e.target.closest?e.target.closest("[data-id]"):null;
    if(!b){if(sel)mark(null);return;}
    mark(b.dataset.id);
    if(window.keelson)window.keelson.action("select-bead",{id:sel});
  });
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&sel)mark(null);});
})();
`;

const LEGEND = `<div class="legend" aria-hidden="true">${(
  [
    ["done", "Done"],
    ["working", "In flight"],
    ["ready", "Ready"],
    ["waiting", "Waiting"],
  ] as const
)
  .map(([lane, label]) => `<span><i class="dot ${lane}"></i>${label}</span>`)
  .join("")}<span class="hint">Hover a bead to trace its chain; click to inspect it.</span></div>`;

function alarm(what: string, error: string): string {
  return `<div class="alarm"><b>UNMEASURED</b>${esc(what)}<pre>${esc(error.slice(0, 1000))}</pre></div>`;
}

function chip(
  node: EpicNode,
  epicId: string,
  common: number | undefined,
  run: LiveRun | undefined,
): string {
  const { member, lane } = node;
  const short = (id: string) => shortId(id, epicId);
  const held = node.dam?.held.length ?? 0;
  const gate = run?.status === "paused" && run.gate && !run.error;
  const tags = [
    gate ? '<span class="tag you">waits on you</span>' : "",
    run && !gate ? `<span class="tag run">${esc(run.phase)}</span>` : "",
    node.pick ? '<span class="tag next">next up</span>' : "",
    node.yours ? '<span class="tag you">your call</span>' : "",
    member.priority === 0 ? '<span class="tag p p0">P0</span>' : "",
    member.priority === 1 && common !== 1 ? '<span class="tag p">P1</span>' : "",
    node.handPaused ? '<span class="tag">paused by hand</span>' : "",
    held > 1
      ? `<span class="tag" title="${esc(`${held} wait on this directly, ${node.dam?.transitive ?? held} downstream`)}">holds ${held}</span>`
      : "",
  ].join("");
  const waits = [
    node.external.length ? `<span class="w">waits on ${esc(node.external.join(", "))}</span>` : "",
    node.deps.length
      ? `<span class="w edge">waits on ${esc(node.deps.map(short).join(" "))}</span>`
      : "",
  ].join("");
  const label = [
    member.id,
    LANE_LABEL[lane],
    ...(gate ? ["run waiting on you"] : run ? [`run in ${run.phase}`] : []),
    member.title,
  ].join(", ");
  const ring = gate ? " gate" : run ? " run" : "";
  return (
    `<button type="button" class="chip ${lane}${ring}" data-id="${esc(member.id)}" data-deps="${esc(node.deps.join(" "))}" aria-label="${esc(label)}">` +
    `<span class="top"><i class="dot ${lane}"></i>${esc(short(member.id))}<span class="tags">${tags}</span></span>` +
    `<span class="t">${esc(clampTitle(member.title, 96))}</span>${waits}</button>`
  );
}

function epicBlock(view: EpicView, runs: ReadonlyMap<string, LiveRun>): string {
  const { row, nodes, done, gate, counts } = view;
  const epicId = row.epic.id;
  const fact = (lane: EpicLane | "", n: number, label: string) =>
    `<span>${lane ? `<i class="dot ${lane}"></i>` : ""}<b>${n}</b> ${esc(label)}</span>`;
  const flags = [
    gate
      ? gate.all
        ? `gated on ${gate.blockerId}`
        : `${gate.count} waiting on ${gate.blockerId}`
      : "",
    row.eligible_for_close ? "closeout review" : "",
  ].filter(Boolean);
  const facts = [
    `<span><b>${row.closed_children}</b> of ${row.total_children} done</span>`,
    ...(counts
      ? [
          counts.working + counts.review > 0
            ? fact("working", counts.working + counts.review, "in flight")
            : "",
          counts.ready > 0 ? fact("ready", counts.ready, "ready") : "",
          counts.waiting > 0 ? fact("waiting", counts.waiting, "waiting") : "",
        ]
      : []),
    ...flags.map((f) => `<span class="flag">${esc(f)}</span>`),
  ].join("");
  const meter =
    row.total_children > 0 && counts
      ? `<div class="meter" role="img" aria-label="${esc(
          `${row.closed_children} done, ${counts.review} in review, ${counts.working} in progress, ${counts.ready} ready, ${counts.waiting} waiting`,
        )}">${(
          [
            ["done", row.closed_children],
            ["review", counts.review],
            ["working", counts.working],
            ["ready", counts.ready],
            ["waiting", counts.waiting],
          ] as const
        )
          .filter(([, n]) => n > 0)
          .map(([lane, n]) => `<i class="m-${lane}" style="flex:${n}"></i>`)
          .join("")}</div>`
      : "";
  const doneLine = done.length
    ? `<div class="donelist"><span class="lbl"><i class="dot done"></i>Done · ${done.length}</span>${done
        .slice(0, DONE_LISTED)
        .map(
          (c) =>
            `<button type="button" data-id="${esc(c.id)}" title="${esc(c.title)}">${esc(shortId(c.id, epicId))}</button>`,
        )
        .join(
          "",
        )}${done.length > DONE_LISTED ? `<span>+${done.length - DONE_LISTED} more</span>` : ""}</div>`
    : "";
  const common = commonPriority(nodes.map((n) => n.member));
  const waveCount = nodes.reduce((max, n) => Math.max(max, n.wave + 1), 0);
  // A wave with no bead draws no column (an epic whose first wave all waits
  // on another epic); the rest keep their numbers.
  const waves = Array.from({ length: waveCount }, (_, w) => ({
    w,
    inWave: nodes.filter((n) => n.wave === w),
  })).filter(({ inWave }) => inWave.length > 0);
  const columns = waves
    .map(({ w, inWave }) => {
      const note = w === 0 ? " · unblocked" : "";
      return `<div class="wave"><h3>Wave ${w + 1} <span>· ${inWave.length}${note}</span></h3>${inWave
        .map((n) => chip(n, epicId, common, runs.get(n.member.id)))
        .join("")}</div>`;
    })
    .join("");
  const shown = waves.length;
  const map = shown
    ? `<div class="scroll"><div class="waves" style="min-width:${shown * 210 + (shown - 1) * 56}px"><svg aria-hidden="true"></svg>${columns}</div></div>`
    : "";
  return (
    `<section class="epic"><div class="head"><div class="ttl"><button type="button" data-id="${esc(epicId)}">${esc(clampTitle(row.epic.title))}</button>` +
    `<span class="eid">${esc(epicId)}</span></div><div class="facts">${facts}</div></div>${meter}${doneLine}${map}</section>`
  );
}

export function epicMapFailed(error: string): string {
  return `<style>${STYLE}</style>${alarm("This project could not be measured. This is not an empty panel.", error)}`;
}

// The region's html fragment. Empty when there is no open epic, which hides
// the region; a failed read renders an alarm, never an empty map.
export function composeEpicMap(m: ProjectMeasurement, live: readonly LiveRun[] = []): string {
  const floor = bdBelowFloor(m);
  if (!m.epics.ok) {
    return `<style>${STYLE}</style>${alarm(
      floor
        ? `Epics need bd ${bdFloorLabel()}. See the header.`
        : "Epics could not be measured. This is not an empty panel.",
      m.epics.error,
    )}`;
  }
  const views = epicViews(m);
  if (views.length === 0) return "";
  const alarms = [
    m.epicChildren.ok
      ? ""
      : alarm(
          "Epic membership could not be measured, so the beads under each epic are missing.",
          m.epicChildren.error,
        ),
    m.blocked.ok
      ? ""
      : alarm(
          "Blocking edges could not be measured, so every bead reads as startable. Do not trust the columns.",
          m.blocked.error,
        ),
    m.ready.ok
      ? ""
      : alarm(
          "The ready queue could not be measured, so ready beads read as waiting.",
          m.ready.error,
        ),
    // Below the floor the header names the cause once.
    stageSplit(m).ok || floor
      ? ""
      : alarm(
          "Review stage could not be measured, so a bead in review reads as in flight and the meter is hidden.",
          (() => {
            const split = stageSplit(m);
            return split.ok ? "" : split.error;
          })(),
        ),
  ].join("");
  const runs = new Map(live.flatMap((r) => (r.beadId ? [[r.beadId, r] as const] : [])));
  return `<style>${STYLE}</style>${alarms}${LEGEND}${views.map((v) => epicBlock(v, runs)).join("")}<script>${SCRIPT}</script>`;
}
