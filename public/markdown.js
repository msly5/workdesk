export function escapeHTML(text = '') {
  return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function safeURL(url) {
  try { const parsed = new URL(url); return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : ''; }
  catch { return ''; }
}
function escapedAt(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}
// Share code-span boundaries with table splitting so a pipe inside code stays in its cell.
function codeSpans(text) {
  const runs = [...text.matchAll(/`+/g)], next = new Map(), closing = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    closing[i] = next.get(runs[i][0].length);
    next.set(runs[i][0].length, i);
  }
  const spans = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i], end = closing[i];
    if (escapedAt(text, run.index) || end === undefined) continue;
    spans.push({start: run.index, end: runs[end].index + run[0].length, content: text.slice(run.index + run[0].length, runs[end].index)});
    i = end;
  }
  return spans;
}
function inline(text, inTable = false) {
  // NUL is reserved for internal tokens; source text must not be able to forge one.
  text = String(text).replaceAll('\u0000', '\ufffd');
  const tokens = [];
  const protect = (raw, html) => { tokens.push({raw, html}); return '\u0000' + (tokens.length - 1) + '\u0000'; };
  const restore = (value, field = 'html') => value.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[i][field]);
  const literal = value => value.replace(/\\([\\`*{}\[\]()#+\-.!_|>~])/g, (_, character) => protect(character, escapeHTML(character)));
  const format = value => value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/~~([^~]+)~~/g, '<del>$1</del>').replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>');
  let value = '', offset = 0;
  for (const span of codeSpans(text)) {
    let content = span.content;
    if (inTable) content = content.replace(/\\\|/g, '|');
    if (content.startsWith(' ') && content.endsWith(' ') && /\S/.test(content)) content = content.slice(1, -1);
    value += literal(text.slice(offset, span.start)) + protect(text.slice(span.start, span.end), '<code>' + escapeHTML(content) + '</code>');
    offset = span.end;
  }
  value += literal(text.slice(offset));
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
    const link = safeURL(restore(url, 'raw'));
    const renderedLabel = restore(format(escapeHTML(label)));
    return protect(match, link ? '<a href="' + escapeHTML(link) + '" target="_blank" rel="noopener noreferrer">' + renderedLabel + '</a>' : renderedLabel);
  });
  return restore(format(escapeHTML(value)));
}
function tableRow(line) {
  const text = line.trim(), cells = [], spans = codeSpans(text);
  let start = 0, spanIndex = 0, separators = 0, first = -1, last = -1;
  for (let i = 0; i < text.length; i++) {
    if (spans[spanIndex]?.start === i) { i = spans[spanIndex++].end - 1; continue; }
    if (text[i] !== '|' || escapedAt(text, i)) continue;
    if (first === -1) first = i;
    last = i; separators++;
    cells.push(text.slice(start, i).trim()); start = i + 1;
  }
  cells.push(text.slice(start).trim());
  if (first === 0) cells.shift();
  if (last === text.length - 1) cells.pop();
  return {cells, separators};
}
function tableHeader(line, delimiter) {
  if (delimiter === undefined || /^(?: {4}|\t)/.test(line) || /^(?: {4}|\t)/.test(delimiter)) return null;
  const header = tableRow(line), divider = tableRow(delimiter);
  if (!(header.separators || divider.separators) || !header.cells.length || header.cells.length !== divider.cells.length || !divider.cells.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return {cells: header.cells, align: divider.cells.map(cell => cell.startsWith(':') ? (cell.endsWith(':') ? 'center' : 'left') : (cell.endsWith(':') ? 'right' : ''))};
}
function tableCells(cells, align, tag) {
  return '<tr>' + align.map((alignment, i) => '<' + tag + (alignment ? ' class="md-align-' + alignment + '"' : '') + '>' + inline(cells[i] || '', true) + '</' + tag + '>').join('') + '</tr>';
}
function fenceStart(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return {marker: match[1][0], length: match[1].length};
}
function blockStart(line) {
  return /^(?: {4}|\t)|^ {0,3}(?:#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)|^\s*(?:-{3,}|\*{3,})\s*$/.test(line) || fenceStart(line);
}
export function markdown(source = '') {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const result = []; let fence = null, codeLines = [], list = '', paragraph = [];
  const flush = () => { if (paragraph.length) { result.push('<p>' + paragraph.map(line => inline(line)).join('<br>') + '</p>'); paragraph = []; } };
  const closeList = () => { if (list) { result.push('</' + list + '>'); list = ''; } };
  const closeCode = () => { result.push('<pre><code>' + escapeHTML(codeLines.join('\n')) + '</code></pre>'); codeLines = []; fence = null; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) closeCode();
      else codeLines.push(line);
      continue;
    }
    const opening = fenceStart(line);
    if (opening) { flush(); closeList(); fence = opening; continue; }
    if (!line.trim()) { flush(); closeList(); continue; }
    const table = !blockStart(line) && tableHeader(line, lines[index + 1]);
    if (table) {
      flush(); closeList();
      let html = '<div class="md-table-scroll" tabindex="0" role="region" aria-label="Markdown 表格"><table><thead>' + tableCells(table.cells, table.align, 'th') + '</thead><tbody>';
      index++;
      while (index + 1 < lines.length && lines[index + 1].trim() && !blockStart(lines[index + 1])) {
        const row = tableRow(lines[index + 1]);
        html += tableCells(row.cells, table.align, 'td'); index++;
      }
      result.push(html + '</tbody></table></div>');
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const item = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);
    if (heading) { flush(); closeList(); const n = heading[1].length; result.push('<h' + n + '>' + inline(heading[2]) + '</h' + n + '>'); }
    else if (/^>\s?/.test(line)) { flush(); closeList(); result.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>'); }
    else if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flush(); closeList(); result.push('<hr>'); }
    else if (item) {
      flush(); const kind = item[2] ? 'ol' : 'ul';
      if (list !== kind) { closeList(); list = kind; result.push('<' + list + '>'); }
      const check = item[3].match(/^\[([ xX])\]\s+(.*)$/);
      result.push('<li' + (check ? ' class="md-check"' : '') + '>' + (check ? '<span>' + (check[1] === ' ' ? '☐' : '☑') + '</span> ' + inline(check[2]) : inline(item[3])) + '</li>');
    } else { closeList(); paragraph.push(line); }
  }
  if (fence) closeCode();
  flush(); closeList(); return result.join('');
}
