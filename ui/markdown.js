/* markdown.js — small, safe Markdown → HTML renderer for model output.
 * Everything is HTML-escaped first; only the tags generated here are emitted.
 * Links render as text (with the URL as a tooltip) so model output can never
 * navigate the app. Covers what transcriptions use: headings, paragraphs,
 * emphasis, code, lists (incl. task items), tables, blockquotes, rules. */
"use strict";

const Markdown = (() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ESC[c]);

  const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const FENCE = /^\s*(```|~~~)/;
  const isBlank = (l) => !l.trim();
  const isTableStart = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);
  const startsBlock = (lines, i) => /^(#{1,6}\s|\s*>)/.test(lines[i]) || FENCE.test(lines[i])
    || LIST_ITEM.test(lines[i]) || isTableStart(lines, i) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]);

  function inline(text) {
    let s = escapeHtml(text);
    const code = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { code.push(c); return `\u0000${code.length - 1}\u0000`; });
    s = s.replace(/&lt;br\s*\/?&gt;/gi, "<br>");
    s = s.replace(/&lt;(sup|sub|u)&gt;(.*?)&lt;\/\1&gt;/gi, "<$1>$2</$1>");
    s = s.replace(/!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/g, '<span class="md-img" title="$2">[image: $1]</span>');
    s = s.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g, '<span class="md-link" title="$2">$1</span>');
    s = s.replace(/\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
    s = s.replace(/(^|[^*\w])\*(?=\S)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_(?=\S)(.+?)_(?![_\w])/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)(.+?)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
  }

  function tableCells(row) {
    return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  }

  function render(src) {
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0, m;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      if ((m = FENCE.exec(line))) {
        const fence = m[1], body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++; // closing fence (or end of a still-streaming block)
        out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
        i++; continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

      if (isTableStart(lines, i)) {
        const aligns = tableCells(lines[i + 1]).map(c =>
          c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "");
        const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c)}</${tag}>`;
        const head = tableCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) rows.push(tableCells(lines[i++]));
        out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead>`
          + `<tbody>${rows.map(r => `<tr>${r.map((c, k) => cell("td", c, k)).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${render(quote.join("\n"))}</blockquote>`);
        continue;
      }

      if ((m = LIST_ITEM.exec(line))) {
        const ordered = /\d/.test(m[2]);
        const start = ordered ? parseInt(m[2], 10) : 1;
        const items = [];
        while (i < lines.length && (m = LIST_ITEM.exec(lines[i])) && /\d/.test(m[2]) === ordered) {
          const depth = Math.floor(m[1].replace(/\t/g, "    ").length / 2);
          let text = m[3];
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) text += " " + lines[i++].trim();
          const task = /^\[([ xX])\]\s+/.exec(text);
          const body = task
            ? `<span class="md-check">${task[1].trim() ? "☑" : "☐"}</span> ${inline(text.slice(task[0].length))}`
            : inline(text);
          items.push(`<li${depth ? ` style="margin-left:${depth * 1.2}em"` : ""}>${body}</li>`);
        }
        out.push(ordered
          ? `<ol${start !== 1 ? ` start="${start}"` : ""}>${items.join("")}</ol>`
          : `<ul>${items.join("")}</ul>`);
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++]);
      out.push(`<p>${para.map(l => inline(l.trim())).join(" ")}</p>`);
    }
    return out.join("\n");
  }

  return { render, escapeHtml };
})();
