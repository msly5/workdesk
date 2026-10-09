export function escapeHTML(text = '') {
  return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function safeURL(url) {
  try { const parsed = new URL(url); return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : ''; }
  catch { return ''; }
}
function inline(text) {
  let value = escapeHTML(text);
  const code = []; const links = [];
  value = value.replace(/`([^`]+)`/g, (_, part) => { code.push('<code>' + part + '</code>'); return '\u0000C' + (code.length - 1) + '\u0000'; });
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const link = safeURL(url.replaceAll('&amp;', '&'));
    links.push(link ? '<a href="' + escapeHTML(link) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label);
    return '\u0000L' + (links.length - 1) + '\u0000';
  });
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/~~([^~]+)~~/g, '<del>$1</del>').replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>');
  return value.replace(/\u0000C(\d+)\u0000/g, (_, i) => code[i]).replace(/\u0000L(\d+)\u0000/g, (_, i) => links[i]);
}
export function markdown(source = '') {
  const lines = String(source).replaceAll('\r\n', '\n').split('\n');
  const result = []; let code = false, codeLines = [], list = '', paragraph = [];
  const flush = () => { if (paragraph.length) { result.push('<p>' + paragraph.map(inline).join('<br>') + '</p>'); paragraph = []; } };
  const closeList = () => { if (list) { result.push('</' + list + '>'); list = ''; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { flush(); closeList(); if (code) { result.push('<pre><code>' + escapeHTML(codeLines.join('\n')) + '</code></pre>'); codeLines = []; } code = !code; continue; }
    if (code) { codeLines.push(line); continue; }
    if (!line.trim()) { flush(); closeList(); continue; }
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
  if (code) result.push('<pre><code>' + escapeHTML(codeLines.join('\n')) + '</code></pre>');
  flush(); closeList(); return result.join('');
}
