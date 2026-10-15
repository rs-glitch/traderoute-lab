// Broker CSV import with a preview step. Parsed in the browser: the file never leaves the device.
import { $, esc, nf } from "./ui.js";
import { importHoldings } from "../engine/holdings-import.js";

export function createImporter(ctx) {
  const dlg = $("#import-dialog");
  const body = $("#import-body");
  const file = $("#import-file");
  let parsed = null;

  function preview(text, label) {
    try { parsed = importHoldings(text); }
    catch (e) { parsed = null; body.innerHTML = `<p class="note">${esc(e.message)}</p>`; $("#import-go").disabled = true; return; }
    const p = parsed;
    body.innerHTML = `<p><b>${esc(p.broker)}</b> file${label ? ` (${esc(label)})` : ""}: ${p.positions.length} positions${p.cash ? `, ${"$" + nf(p.cash, 2)} cash` : ""}.</p>
      <div class="table-wrap" style="max-height:260px"><table><thead><tr><th>Ticker</th><th class="num">Shares</th><th class="num">Cost basis</th><th>Description</th></tr></thead>
      <tbody>${p.positions.map((x) => `<tr><td class="mono">${esc(x.symbol)}</td><td class="num">${nf(x.shares, x.shares % 1 ? 4 : 0)}</td><td class="num">${x.costBasis == null ? "—" : "$" + nf(x.costBasis, 2)}</td><td class="sub">${esc((x.description || "").slice(0, 32))}</td></tr>`).join("")}</tbody></table></div>
      ${p.warnings.length ? `<ul class="note">${p.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${p.skipped.length ? `<details><summary class="sub">${p.skipped.length} rows skipped</summary><ul class="sub">${p.skipped.map((s) => `<li>line ${s.line}: ${esc(s.text)}: ${esc(s.reason)}</li>`).join("")}</ul></details>` : ""}
      <label class="toggle" style="margin-top:10px"><span>Use the imported cash${p.cash ? "" : " (none found; keeps your current cash)"}</span><input type="checkbox" id="import-cash" ${p.cash ? "checked" : "disabled"}></label>
      <p class="sub">Importing replaces your current holdings and resets the paper-trading account. The file was read in your browser and not uploaded.</p>`;
    $("#import-go").disabled = false;
  }

  file.addEventListener("change", async () => { const f = file.files[0]; if (f) preview(await f.text(), f.name); file.value = ""; });
  for (const b of dlg.querySelectorAll("[data-sample]")) b.addEventListener("click", async () => preview(await (await fetch(`/web/samples/${b.dataset.sample}.csv`)).text(), `sample: ${b.textContent}`));
  $("#import-cancel").addEventListener("click", () => dlg.close());
  $("#import-go").addEventListener("click", async () => {
    if (!parsed) return;
    $("#import-go").disabled = true;
    body.insertAdjacentHTML("beforeend", `<p class="sub" id="import-status">Loading price history…</p>`);
    const res = await ctx.applyImport(parsed, $("#import-cash")?.checked);
    if (res.failed.length) $("#import-status").textContent = `Imported. No price data for: ${res.failed.join(", ")} (kept, but excluded from charts).`;
    setTimeout(() => dlg.close(), res.failed.length ? 1800 : 200);
  });

  return {
    open() { parsed = null; body.innerHTML = `<p class="sub">Export <b>Positions</b> as CSV from Schwab or Fidelity, or <b>account activity</b> from Robinhood, then choose the file. Or try a sample.</p>`; $("#import-go").disabled = true; dlg.showModal(); },
    async sample(name) { const text = await (await fetch(`/web/samples/${name}.csv`)).text(); parsed = importHoldings(text); return ctx.applyImport(parsed, true); },
  };
}
