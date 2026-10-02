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
  type EpicLane,
  type EpicNode,
  type EpicView,
  epicViews,
  shortId,
  stageSplit,
} from "./board";
import { bdBelowFloor, type ProjectMeasurement } from "./measure";

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

// Host palette values (keelson design tokens), dark first like the SPA; the
// host stamps data-theme on the frame's root and pushes later toggles.
const STYLE = `
:root{--bg:#161e3b;--card:#1f2a4d;--border:#2a3258;--fg:#d8def0;--fg-strong:#f0f3ff;--muted:#8993b2;
--accent:#9b8eff;--good:#6dd28d;--warn:#f5c352;--crit:#f08793;--info:#7cc0ff;--on-accent:#0d1429;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;color-scheme:dark}
:root[data-theme="light"]{--bg:#ffffff;--card:#f3f0fa;--border:#c8bfdc;--fg:#161b31;--fg-strong:#0b0f1e;--muted:#5d5876;
--accent:#6d4fe0;--good:#15834f;--warn:#b57a00;--crit:#d9385e;--info:#2e6fd8;--on-accent:#ffffff;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:4px 2px 8px;background:var(--bg);color:var(--fg);font:13px/1.4 var(--sans)}
.epic+.epic{margin-top:22px;padding-top:18px;border-top:1px solid var(--border)}
.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.head button{font:600 15px/1.3 var(--sans);color:var(--fg-strong);background:none;border:0;padding:0;cursor:pointer;text-align:left}
.meta{font:12px var(--mono);color:var(--muted)}
.meter{display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;background:var(--card);margin:8px 0 2px}
.meter i{display:block;height:100%}
.m-done{background:var(--good)}.m-review{background:var(--accent);opacity:.6}.m-working{background:var(--info)}
.m-ready{background:var(--accent)}.m-waiting{background:transparent}
.done{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:10px;font-size:12px;color:var(--muted)}
.done button{font:12px var(--mono);color:var(--fg);background:none;border:1px solid var(--border);border-radius:4px;padding:0 5px;cursor:pointer}
.scroll{overflow-x:auto;margin-top:12px}
.waves{position:relative;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(190px,1fr);gap:8px 48px;align-items:start}
.waves svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.waves path{fill:none;stroke:var(--muted);stroke-width:1.2;opacity:.55}
.waves path.hot{stroke:var(--accent);stroke-width:2;opacity:1}
.waves.lit path:not(.hot){opacity:.12}
.wave{display:flex;flex-direction:column;gap:8px;position:relative;z-index:1;min-width:0}
.wave h3{margin:0 0 2px;font:600 11px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.wave h3 span{font-weight:400;letter-spacing:0;text-transform:none}
.chip{display:block;width:100%;text-align:left;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:7px 10px;cursor:pointer}
.chip .top{display:flex;align-items:center;gap:6px;font:12px var(--mono);color:var(--muted)}
.chip .tags{margin-left:auto;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}
.chip .t{display:block;margin-top:3px;line-height:1.3}
.chip .w{display:block;margin-top:3px;font:11.5px var(--mono);color:var(--muted)}
.chip .w.edge{display:none}
.chip.working{border-color:var(--info)}.chip.review{border-color:var(--accent)}.chip.ready{border-color:var(--accent)}
.chip.waiting .t,.chip.hold .t{color:var(--muted)}
.chip.sel{box-shadow:0 0 0 2px var(--accent)}
.waves.lit .chip:not(.on){opacity:.4}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dot{width:10px;height:10px;border-radius:50%;flex:none;display:inline-block}
.dot.working{background:linear-gradient(90deg,var(--info) 50%,transparent 50%);border:1.5px solid var(--info)}
.dot.review{background:var(--accent);opacity:.6}.dot.ready{background:var(--accent)}
.dot.waiting{border:1.5px solid var(--muted)}.dot.hold{border:1.5px dashed var(--muted)}
.tag{font:600 11px var(--sans);padding:1px 6px;border-radius:4px;white-space:nowrap;background:var(--card);color:var(--fg)}
.tag.next{background:var(--accent);color:var(--on-accent)}
.tag.p{color:var(--warn)}.tag.p0{color:var(--crit)}
.alarm{border:1px solid var(--crit);border-radius:8px;padding:8px 10px;margin-bottom:10px}
.alarm b{color:var(--crit);font:600 11px var(--mono);margin-right:8px}
.alarm pre{margin:6px 0 0;font:11.5px var(--mono);color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:720px){.waves{grid-auto-flow:row;grid-auto-columns:auto;min-width:0!important;gap:14px}
.waves svg{display:none}.chip .w.edge{display:block}}
@media (prefers-reduced-motion:no-preference){.chip{transition:opacity .12s}}
`;

// Draws one curve per blocking edge, lights a bead's chain on hover or focus,
// and posts select-bead (the one verb the rib honours from a frame).
const SCRIPT = `
(function(){
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
    function draw(){
      var r=map.getBoundingClientRect();svg.innerHTML="";edges=[];
      Object.keys(deps).forEach(function(id){deps[id].forEach(function(d){
        var a=chips[d].getBoundingClientRect(),z=chips[id].getBoundingClientRect();
        var x1=a.right-r.left,y1=a.top+a.height/2-r.top,x2=z.left-r.left,y2=z.top+z.height/2-r.top,dx=Math.min(40,(x2-x1)/2);
        var p=document.createElementNS("http://www.w3.org/2000/svg","path");
        p.setAttribute("d","M"+x1+" "+y1+" C"+(x1+dx)+" "+y1+","+(x2-dx)+" "+y2+","+x2+" "+y2);
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
  document.addEventListener("click",function(e){
    var b=e.target&&e.target.closest?e.target.closest("[data-id]"):null;
    if(!b)return;
    sel=b.dataset.id;
    document.querySelectorAll(".chip").forEach(function(c){c.classList.toggle("sel",c.dataset.id===sel);});
    document.querySelectorAll(".waves").forEach(function(m){m._rest();});
    if(window.keelson)window.keelson.action("select-bead",{id:sel});
  });
})();
`;

function alarm(what: string, error: string): string {
  return `<div class="alarm"><b>UNMEASURED</b>${esc(what)}<pre>${esc(error.slice(0, 1000))}</pre></div>`;
}

function chip(node: EpicNode, epicId: string): string {
  const { member, lane } = node;
  const short = (id: string) => shortId(id, epicId);
  const held = node.dam?.held.length ?? 0;
  const tags = [
    node.pick ? '<span class="tag next">next up</span>' : "",
    member.priority === 0 ? '<span class="tag p p0">P0</span>' : "",
    member.priority === 1 ? '<span class="tag p">P1</span>' : "",
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
  const label = `${member.id}, ${LANE_LABEL[lane]}, ${member.title}`;
  return (
    `<button type="button" class="chip ${lane}" data-id="${esc(member.id)}" data-deps="${esc(node.deps.join(" "))}" aria-label="${esc(label)}">` +
    `<span class="top"><i class="dot ${lane}"></i>${esc(short(member.id))}<span class="tags">${tags}</span></span>` +
    `<span class="t">${esc(clampTitle(member.title, 96))}</span>${waits}</button>`
  );
}

function epicBlock(view: EpicView): string {
  const { row, nodes, done, gate, counts } = view;
  const epicId = row.epic.id;
  const meta = [
    epicId,
    `${row.closed_children} of ${row.total_children} done`,
    ...(counts
      ? [
          counts.working + counts.review > 0 ? `${counts.working + counts.review} in flight` : "",
          `${counts.ready} ready`,
          `${counts.waiting} waiting`,
        ]
      : []),
    gate
      ? gate.all
        ? `gated on ${gate.blockerId}`
        : `${gate.count} waiting on ${gate.blockerId}`
      : "",
    row.eligible_for_close ? "closeout review" : "",
  ].filter(Boolean);
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
    ? `<div class="done"><span>Done · ${done.length}</span>${done
        .slice(0, DONE_LISTED)
        .map(
          (c) =>
            `<button type="button" data-id="${esc(c.id)}" title="${esc(c.title)}">${esc(shortId(c.id, epicId))}</button>`,
        )
        .join(
          "",
        )}${done.length > DONE_LISTED ? `<span>+${done.length - DONE_LISTED} more</span>` : ""}</div>`
    : "";
  const waveCount = nodes.reduce((max, n) => Math.max(max, n.wave + 1), 0);
  const columns = Array.from({ length: waveCount }, (_, w) => {
    const inWave = nodes.filter((n) => n.wave === w);
    const title = w === 0 ? "No open blockers" : `Wave ${w + 1}`;
    return `<div class="wave"><h3>${title} <span>· ${inWave.length}</span></h3>${inWave
      .map((n) => chip(n, epicId))
      .join("")}</div>`;
  }).join("");
  const map = waveCount
    ? `<div class="scroll"><div class="waves" style="min-width:${waveCount * 190 + (waveCount - 1) * 48}px"><svg aria-hidden="true"></svg>${columns}</div></div>`
    : "";
  return (
    `<section class="epic"><div class="head"><button type="button" data-id="${esc(epicId)}">${esc(clampTitle(row.epic.title))}</button>` +
    `<span class="meta">${esc(meta.join(" · "))}</span></div>${meter}${doneLine}${map}</section>`
  );
}

export function epicMapFailed(error: string): string {
  return `<style>${STYLE}</style>${alarm("This project could not be measured. This is not an empty panel.", error)}`;
}

// The region's html fragment. Empty when there is no open epic, which hides
// the region; a failed read renders an alarm, never an empty map.
export function composeEpicMap(m: ProjectMeasurement): string {
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
  return `<style>${STYLE}</style>${alarms}${views.map(epicBlock).join("")}<script>${SCRIPT}</script>`;
}
