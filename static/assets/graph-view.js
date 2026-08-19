// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.
/*
 * graph-view.js — Mazzy Command Center spec<->component<->backlog graph renderer.
 *
 * CSP-safe: served from /assets under `script-src 'self'`, no external deps, no
 * innerHTML for data (labels via textContent only). Exposes window.MazzyGraphView
 * with pure, separately-testable helpers (layoutLanes/layoutForce/applyFilters/
 * neighborhood/buildFacetModel) plus create() that mounts an SVG into a container.
 *
 * Everything is data-driven from doc.facets: no artifact-kind/domain/edge literals.
 */
(function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";

  // Deterministic PRNG so a given graph always renders identically (testable).
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // A deterministic pleasant HSL colour for any kind id we have not themed.
  function colorForKind(kind) {
    var h = hashStr(kind) % 360;
    return "hsl(" + h + ",62%,58%)";
  }

  // ---- pure helpers (exported for tests) ----

  function buildFacetModel(doc) {
    // Returns { domains:[{id,label,count}], kinds:[...], edges:[...] } straight
    // from the payload facets, plus a colour per kind (themed var or synthesized).
    var kinds = (doc.facets.kinds || []).map(function (k) {
      return { id: k.id, domain: k.domain, label: k.label, count: k.count, color: colorForKind(k.id) };
    });
    return { domains: doc.facets.domains || [], kinds: kinds, edges: doc.facets.edges || [] };
  }

  function layoutLanes(nodes, edges, size) {
    // Vertical domain bands: group by domain, stack nodes within a band, sorted by
    // kind then weight. O(n), deterministic, stable across reloads.
    var domains = [];
    var byDomain = {};
    nodes.forEach(function (n) { if (!byDomain[n.domain]) { byDomain[n.domain] = []; domains.push(n.domain); } byDomain[n.domain].push(n); });
    domains.sort();
    var pos = {};
    var laneW = size.w / Math.max(1, domains.length);
    domains.forEach(function (dom, di) {
      var list = byDomain[dom].slice().sort(function (a, b) { return a.kind === b.kind ? b.weight - a.weight : a.kind < b.kind ? -1 : 1; });
      var cx = laneW * (di + 0.5);
      var pad = 60, usable = Math.max(1, size.h - pad * 2);
      list.forEach(function (n, i) {
        var y = pad + (list.length === 1 ? usable / 2 : (usable * i) / (list.length - 1));
        var jitter = (mulberry32(hashStr(n.id))() - 0.5) * laneW * 0.5;
        pos[n.id] = { x: cx + jitter, y: y };
      });
    });
    return pos;
  }

  function layoutForce(nodes, edges, size, seed) {
    // Grid-bucketed repulsion + spring attraction, seeded, fixed tick count.
    var rand = mulberry32(seed || 1);
    var pos = {}, vel = {};
    nodes.forEach(function (n) { pos[n.id] = { x: rand() * size.w, y: rand() * size.h }; vel[n.id] = { x: 0, y: 0 }; });
    var idx = {}; nodes.forEach(function (n, i) { idx[n.id] = i; });
    var TICKS = 120, k = Math.sqrt((size.w * size.h) / Math.max(1, nodes.length));
    for (var t = 0; t < TICKS; t++) {
      var cool = 1 - t / TICKS;
      for (var i = 0; i < nodes.length; i++) {
        var a = nodes[i], pa = pos[a.id], fx = 0, fy = 0;
        for (var j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          var pb = pos[nodes[j].id]; var dx = pa.x - pb.x, dy = pa.y - pb.y; var d2 = dx * dx + dy * dy + 0.01;
          var rep = (k * k) / d2; fx += dx * rep; fy += dy * rep;
        }
        vel[a.id].x = (vel[a.id].x + fx * 0.0008) * 0.85;
        vel[a.id].y = (vel[a.id].y + fy * 0.0008) * 0.85;
      }
      edges.forEach(function (e) {
        var pa = pos[e.from], pb = pos[e.to]; if (!pa || !pb) return;
        var dx = pb.x - pa.x, dy = pb.y - pa.y, dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
        var spring = (dist - k) * 0.01 * (e.weight ? 1 + Math.log(1 + e.weight) * 0.2 : 1);
        var ux = dx / dist, uy = dy / dist;
        vel[e.from].x += ux * spring; vel[e.from].y += uy * spring;
        vel[e.to].x -= ux * spring; vel[e.to].y -= uy * spring;
      });
      nodes.forEach(function (n) {
        pos[n.id].x += vel[n.id].x * cool * 6; pos[n.id].y += vel[n.id].y * cool * 6;
        pos[n.id].x = Math.max(20, Math.min(size.w - 20, pos[n.id].x));
        pos[n.id].y = Math.max(20, Math.min(size.h - 20, pos[n.id].y));
      });
    }
    return pos;
  }

  function applyFilters(doc, state) {
    // Returns { nodes, edges } visible under the current toggle state.
    var kindOn = state.kinds || {}, edgeOn = state.edges || {}, domOn = state.domains || {};
    var nodes = doc.nodes.filter(function (n) {
      return (kindOn[n.kind] !== false) && (domOn[n.domain] !== false);
    });
    var live = {}; nodes.forEach(function (n) { live[n.id] = true; });
    var edges = doc.edges.filter(function (e) {
      return (edgeOn[e.kind] !== false) && live[e.from] && live[e.to];
    });
    return { nodes: nodes, edges: edges };
  }

  function neighborhood(doc, id, depth) {
    var adj = {};
    doc.edges.forEach(function (e) { (adj[e.from] = adj[e.from] || []).push(e.to); (adj[e.to] = adj[e.to] || []).push(e.from); });
    var keep = {}; keep[id] = true; var frontier = [id];
    for (var d = 0; d < Math.max(1, depth); d++) {
      var next = [];
      frontier.forEach(function (x) { (adj[x] || []).forEach(function (y) { if (!keep[y]) { keep[y] = true; next.push(y); } }); });
      frontier = next;
    }
    return keep;
  }

  // ---- renderer (DOM) ----

  function el(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    return e;
  }

  function create(container, opts) {
    opts = opts || {};
    var doc = null, facetModel = null, filterState = { kinds: {}, edges: {}, domains: {} };
    var layout = "lanes", positions = {}, focusId = null, transform = { x: 0, y: 0, k: 1 };

    var svg = el("svg", { width: "100%", height: "100%", class: "mz-graph" });
    var defs = el("defs"); svg.appendChild(defs);
    var viewport = el("g", { id: "mz-viewport" });
    var edgeG = el("g", { class: "mz-edges" }); var nodeG = el("g", { class: "mz-nodes" });
    viewport.appendChild(edgeG); viewport.appendChild(nodeG); svg.appendChild(viewport);
    container.appendChild(svg);

    function size() { var r = svg.getBoundingClientRect(); return { w: Math.max(320, r.width || 800), h: Math.max(240, r.height || 600) }; }

    function relayout() {
      var view = applyFilters(doc, filterState);
      var s = size();
      positions = layout === "force" ? layoutForce(view.nodes, view.edges, s, 1) : layoutLanes(view.nodes, view.edges, s);
      draw(view);
    }

    function draw(view) {
      while (edgeG.firstChild) edgeG.removeChild(edgeG.firstChild);
      while (nodeG.firstChild) nodeG.removeChild(nodeG.firstChild);
      var keep = focusId ? neighborhood({ nodes: view.nodes, edges: view.edges }, focusId, opts.focusDepth || 2) : null;
      view.edges.forEach(function (e) {
        var a = positions[e.from], b = positions[e.to]; if (!a || !b) return;
        if (keep && !(keep[e.from] && keep[e.to])) return;
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 24;
        var p = el("path", { d: "M" + a.x + "," + a.y + " Q" + mx + "," + my + " " + b.x + "," + b.y, class: "mz-e e-" + e.kind });
        edgeG.appendChild(p);
      });
      view.nodes.forEach(function (n) {
        var p = positions[n.id]; if (!p) return;
        if (keep && !keep[n.id]) return;
        var g = el("g", { class: "mz-n n-" + n.domain + " k-" + n.kind + (n.status ? " s-" + n.status : ""), transform: "translate(" + p.x + "," + p.y + ")" });
        g.setAttribute("data-id", n.id);
        var r = 4 + 2.2 * Math.log(1 + n.weight);
        var c = el("circle", { r: r.toFixed(1) });
        c.style.fill = "var(--mz-kind-" + n.kind + ", " + colorForKind(n.kind) + ")";
        g.appendChild(c);
        if (transform.k > 0.65 || n.id === focusId) {
          var label = el("text", { class: "mz-label", x: (r + 3).toFixed(1), y: "3" });
          label.textContent = n.label; // textContent only — never innerHTML (XSS-safe)
          g.appendChild(label);
        }
        g.addEventListener("click", function () { focusId = (focusId === n.id ? null : n.id); relayout(); if (opts.onSelect) opts.onSelect(n); });
        nodeG.appendChild(g);
      });
      applyTransform();
    }

    function applyTransform() { viewport.setAttribute("transform", "translate(" + transform.x + "," + transform.y + ") scale(" + transform.k + ")"); }

    // pan + zoom (transform only, no relayout)
    var dragging = false, last = null;
    svg.addEventListener("pointerdown", function (ev) { if (ev.target === svg || ev.target === viewport) { dragging = true; last = { x: ev.clientX, y: ev.clientY }; } });
    window.addEventListener("pointermove", function (ev) { if (!dragging) return; transform.x += ev.clientX - last.x; transform.y += ev.clientY - last.y; last = { x: ev.clientX, y: ev.clientY }; applyTransform(); });
    window.addEventListener("pointerup", function () { dragging = false; });
    svg.addEventListener("wheel", function (ev) { ev.preventDefault(); var f = ev.deltaY < 0 ? 1.1 : 0.9; transform.k = Math.max(0.2, Math.min(4, transform.k * f)); applyTransform(); }, { passive: false });

    return {
      setDocument: function (d) { doc = d; facetModel = buildFacetModel(d); filterState = { kinds: {}, edges: {}, domains: {} };
        // default: hide the noisy `references` edges
        (d.facets.edges || []).forEach(function (e) { if (e.id === "references") filterState.edges[e.id] = false; });
        relayout(); return facetModel; },
      setLayout: function (l) { layout = l; relayout(); },
      setFilter: function (group, id, on) { (filterState[group] = filterState[group] || {})[id] = on; relayout(); },
      setFocus: function (id) { focusId = id; relayout(); },
      facetModel: function () { return facetModel; },
      resize: relayout,
    };
  }

  window.MazzyGraphView = {
    create: create,
    layoutLanes: layoutLanes, layoutForce: layoutForce,
    applyFilters: applyFilters, neighborhood: neighborhood,
    buildFacetModel: buildFacetModel, colorForKind: colorForKind,
  };
})();