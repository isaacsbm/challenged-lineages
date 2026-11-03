// Entry point: load the data, draw the graph, and connect the toolbar and panels.

import { loadCollection } from "./data.js";
import { createGraph } from "./graph.js";
import {
  defaultLayers, computeVisibility, buildLayersPanel,
  createDetailPanel, buildLegend, setupSearch, buildRecordList,
} from "./panels.js";

const $ = (selector) => document.querySelector(selector);

async function main() {
  // Labels are measured to size the layout, so the web fonts must be ready first.
  await Promise.all([
    document.fonts.load('700 16px "EB Garamond"'),
    document.fonts.load('600 14px "EB Garamond"'),
    document.fonts.load('italic 400 13px "EB Garamond"'),
    document.fonts.load('500 10px "EB Garamond"'),
  ]);
  await document.fonts.ready;

  const model = await loadCollection("data/collection.jsonld", "terms/ccv.jsonld");
  const layers = defaultLayers(model);
  const status = $("#status");

  const detail = createDetailPanel($("#detail-panel"), model, {
    onNavigate: (id) => {
      if (graph.isVisible(id)) graph.focusNode(id, { moveFocus: false });
      else graph.select(id); // hidden on the map, but its record can still be read
    },
    onClose: () => graph.select(null),
  });

  // Opening a record moves keyboard focus into it; closing returns focus to whatever
  // opened it (a node, a search result, or a button in the record list). Following a
  // link from one record to the next keeps the original return point.
  let returnFocus = null;
  const graph = createGraph($("#graph"), model, {
    // Keep fitted content clear of the toolbar (top) and the title block (bottom).
    insets: () => ({
      top: $(".toolbar").getBoundingClientRect().bottom - $("#graph").getBoundingClientRect().top + 8,
      bottom: $(".title-block").offsetHeight + 8,
    }),
    onSelect: (node) => {
      if (node) {
        if (!$("#detail-panel").contains(document.activeElement)) returnFocus = document.activeElement;
        detail.show(node);
        $("#detail-title").focus({ preventScroll: true });
      } else {
        detail.hide();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        returnFocus = null;
      }
    },
  });

  // --- Layers ---------------------------------------------------------------------------
  const redactButton = $("#toggle-redaction");
  let lastRedaction = "challenged"; // the level the toolbar button switches on

  function updateLayers() {
    const visibility = computeVisibility(model, layers);
    graph.applyVisibility(visibility);
    const redacted = graph.setRedaction(layers.redaction);
    if (layers.redaction !== "off") lastRedaction = layers.redaction;
    redactButton.setAttribute("aria-pressed", String(layers.redaction !== "off"));
    const shown = model.nodes.filter((n) => visibility.nodeIds.has(n.id));
    const count = (kind) => shown.filter((n) => n.kind === kind).length;
    status.textContent = `Showing ${count("work")} works, ${count("instance")} instances, `
      + `${count("source")} source works, and ${visibility.linkIds.size} links.`
      + (redacted ? ` ${redacted} redacted.` : "");
  }
  const layersPanel = buildLayersPanel($("#layers-body"), model, layers, updateLayers);
  redactButton.addEventListener("click", () => {
    layers.redaction = layers.redaction === "off" ? lastRedaction : "off";
    layersPanel.sync();
    updateLayers();
  });
  buildLegend($("#legend-panel"));
  buildRecordList($("#list-body"), model, (id) => {
    // Open the record; if the layers hide it on the map, open it without moving the view.
    if (graph.isVisible(id)) graph.focusNode(id, { moveFocus: false });
    else graph.select(id);
  });
  updateLayers();
  graph.fit(false);

  // --- Toolbar --------------------------------------------------------------------------
  // Layers, Legend, and List share the left side; opening one closes the others.
  const drawers = {
    "#toggle-layers": "#layers-panel",
    "#toggle-legend": "#legend-panel",
    "#toggle-list": "#list-panel",
  };
  for (const [buttonSel, panelSel] of Object.entries(drawers)) {
    $(buttonSel).addEventListener("click", () => {
      const opening = $(panelSel).hidden;
      for (const [b, p] of Object.entries(drawers)) {
        $(p).hidden = true;
        $(b).setAttribute("aria-expanded", "false");
      }
      $(panelSel).hidden = !opening;
      $(buttonSel).setAttribute("aria-expanded", String(opening));
    });
  }
  document.querySelectorAll(".drawer .close").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.closest(".drawer");
      panel.hidden = true;
      const toggle = document.querySelector(`[aria-controls="${panel.id}"]`);
      toggle?.setAttribute("aria-expanded", "false");
      toggle?.focus();
    });
  });

  document.querySelectorAll('input[name="label-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => graph.setLabelMode(radio.value));
  });
  $("#zoom-in").addEventListener("click", () => graph.zoomBy(1.4));
  $("#zoom-out").addEventListener("click", () => graph.zoomBy(1 / 1.4));
  $("#zoom-fit").addEventListener("click", () => graph.fit());
  $("#reset-layout").addEventListener("click", () => graph.resetLayout());
  $("#open-about").addEventListener("click", () => $("#about").showModal());
  $("#about .close").addEventListener("click", () => $("#about").close());

  setupSearch($("#search-form"), $("#search"), $("#titles"), model, (node, query) => {
    if (!node) {
      status.textContent = `No title matches “${query}”.`;
    } else if (!graph.isVisible(node.id)) {
      status.textContent = `${node.title} is hidden by the current layers. Use Reset in the Layers panel to show it.`;
    } else {
      graph.focusNode(node.id);
    }
  });

  // On narrow screens the controls fold away behind a Menu button.
  const menuButton = $("#toggle-controls");
  menuButton.addEventListener("click", () => {
    const open = menuButton.getAttribute("aria-expanded") !== "true";
    menuButton.setAttribute("aria-expanded", String(open));
    $("#toolbar-more").classList.toggle("open", open);
  });

  // Escape closes the innermost thing open: the record, then a side panel.
  // (The About dialog handles Escape itself.)
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || $("#about").open) return;
    if (!$("#detail-panel").hidden) {
      graph.select(null);
      return;
    }
    const open = document.querySelector(".drawer-left:not([hidden])");
    open?.querySelector(".close").click();
  });
}

main().catch((error) => {
  console.error(error);
  const message = $("#load-error");
  message.hidden = false;
  message.querySelector(".detail").textContent = error.message;
});
