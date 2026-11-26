export function node(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children.flat().filter((child) => child != null));
  return element;
}

export function link(label, href, className) {
  const element = node('a', className, label);
  element.href = href;
  return element;
}

export function button(label, className) {
  const element = node('button', className, label);
  element.type = 'button';
  return element;
}

export function entryHref(collection, id = '', section = '', from = '') {
  const query = new URLSearchParams();
  if (section) query.set('section', section);
  if (from) query.set('from', from);
  const search = query.toString();
  return `#/${collection}${id ? `/${id}` : ''}${search ? `?${search}` : ''}`;
}

export function termIndex(terms, currentEntry, from) {
  const published = terms.filter((term) => !currentEntry || currentEntry !== term.entry);
  const byName = new Map(published.map((term) => [term.name, term]));
  const names = [...byName.keys()].sort((first, second) => second.length - first.length);
  const pattern = names.length ? new RegExp(names.map((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^[a-z0-9]/i.test(name) ? '(?<![a-zA-Z0-9])' : '';
    const right = /[a-z0-9]$/i.test(name) ? '(?![a-zA-Z0-9])' : '';
    return `${left}${escaped}${right}`;
  }).join('|'), 'gu') : null;
  return { byName, pattern, from };
}

function appendTerms(parent, text, terms) {
  let offset = 0;
  for (const match of terms.pattern ? text.matchAll(terms.pattern) : []) {
    const term = terms.byName.get(match[0]);
    const trigger = term.entry
      ? link(term.name, entryHref(term.collection, term.entry, term.section, terms.from), 'term')
      : button(term.name, 'term');
    trigger.dataset.term = term.name;
    parent.append(text.slice(offset, match.index), trigger);
    offset = match.index + term.name.length;
  }
  if (offset < text.length) parent.append(text.slice(offset));
}

function inline(parent, text, terms, resolveRoute) {
  const pattern = /(`([^`\n]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|(!?)\[([^\]\n]+)\]\(([^)\n]+)\))/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    appendTerms(parent, text.slice(offset, match.index), terms);
    const [, , code, strong, strongAlt, emphasis, image, label, href] = match;
    const destination = label && !image ? resolveRoute(href) : null;
    if (code) {
      parent.append(node('code', '', code));
    } else if (destination) {
      parent.append(link(label, destination));
    } else if (label) {
      appendTerms(parent, label, terms);
    } else {
      const element = node(emphasis ? 'em' : 'strong');
      appendTerms(element, strong ?? strongAlt ?? emphasis, terms);
      parent.append(element);
    }
    offset = match.index + match[0].length;
  }
  appendTerms(parent, text.slice(offset), terms);
  return parent;
}

const headingPattern = /^#{1,6}\s+(.+?)(?:\s+#+)?$/;
const rulePattern = /^(?:(?:\*\s*){3,}|(?:＊\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const listPattern = /^(?:(\d+)[.)]|[-*+])\s+(.+)$/;

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

export function renderMarkdown(source, terms, resolveRoute) {
  const lines = source.split(/\r?\n/).map((line) => line.trim());
  const content = document.createDocumentFragment();
  const startsTable = (index) => lines[index]?.includes('|') && lines[index + 1]?.includes('-')
    && tableCells(lines[index + 1]).every((cell) => /^:?-{3,}:?$/.test(cell));
  const startsBlock = (index) => headingPattern.test(lines[index]) || rulePattern.test(lines[index])
    || listPattern.test(lines[index]) || lines[index]?.startsWith('>') || startsTable(index);

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const heading = line.match(headingPattern);
    const item = line.match(listPattern);
    if (!line) {
      index++;
    } else if (heading) {
      const level = Math.max(2, line.indexOf(' '));
      const element = inline(node(`h${level}`), heading[1], { pattern: null }, resolveRoute);
      element.dataset.section = element.textContent;
      content.append(element);
      index++;
    } else if (rulePattern.test(line)) {
      content.append(node('hr'));
      index++;
    } else if (line.startsWith('>')) {
      const quote = [];
      while (lines[index]?.startsWith('>')) quote.push(lines[index++].replace(/^>\s?/, ''));
      content.append(node('blockquote', '', renderMarkdown(quote.join('\n'), terms, resolveRoute)));
    } else if (item) {
      const ordered = Boolean(item[1]);
      const list = node(ordered ? 'ol' : 'ul');
      if (ordered) list.start = Number(item[1]);
      for (let next; (next = lines[index]?.match(listPattern)) && Boolean(next[1]) === ordered; index++) {
        list.append(inline(node('li'), next[2], terms, resolveRoute));
      }
      content.append(list);
    } else if (startsTable(index)) {
      const head = node('tr');
      for (const value of tableCells(line)) {
        const cell = inline(node('th'), value, terms, resolveRoute);
        cell.scope = 'col';
        head.append(cell);
      }
      const rows = node('tbody');
      index += 2;
      while (lines[index]?.includes('|')) {
        const row = node('tr');
        for (const value of tableCells(lines[index++])) row.append(inline(node('td'), value, terms, resolveRoute));
        rows.append(row);
      }
      content.append(node('div', 'table-wrap', node('table', '', node('thead', '', head), rows)));
    } else {
      const paragraph = [line];
      index++;
      while (lines[index] && !startsBlock(index)) paragraph.push(lines[index++]);
      content.append(inline(node('p'), paragraph.join('\n'), terms, resolveRoute));
    }
  }
  return content;
}

export function installTermPreviews(main, panel, lookup) {
  let active;
  let pinned = false;
  let hideTimer;
  let pointerType;

  function close() {
    clearTimeout(hideTimer);
    active?.removeAttribute('aria-describedby');
    panel.hidden = true;
    active = null;
    pinned = false;
  }

  function show(trigger, pin = false) {
    const term = lookup(trigger.dataset.term);
    if (!term) return;
    close();
    active = trigger;
    pinned = pin;
    const definition = node('p', '', term.definition);
    definition.id = 'term-definition';
    panel.replaceChildren(node('strong', '', term.name), definition);
    if (term.entry) {
      panel.append(link(term.collection === 'archives' ? '查看档案' : '查看设定',
        trigger.getAttribute('href'), 'text-link'));
    }
    panel.hidden = false;
    const target = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(10, Math.min(target.left, document.documentElement.clientWidth - width - 10));
    const top = target.bottom + height + 8 <= window.innerHeight ? target.bottom + 6 : Math.max(8, target.top - height - 6);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    trigger.setAttribute('aria-describedby', definition.id);
  }

  function waitToClose() {
    clearTimeout(hideTimer);
    if (!pinned) hideTimer = setTimeout(close, 190);
  }

  main.addEventListener('pointerdown', (event) => { pointerType = event.pointerType; });
  main.addEventListener('pointerover', (event) => {
    const trigger = event.target.closest('.term');
    if (trigger && event.pointerType === 'mouse') {
      clearTimeout(hideTimer);
      if (active !== trigger) show(trigger);
    }
  });
  main.addEventListener('pointerout', (event) => {
    if (event.target.closest('.term') === active && active && !active.contains(event.relatedTarget)) waitToClose();
  });
  main.addEventListener('focusin', (event) => {
    const trigger = event.target.closest('.term');
    if (trigger && active !== trigger) show(trigger);
  });
  main.addEventListener('focusout', (event) => {
    if (event.target === active && !panel.contains(event.relatedTarget)) waitToClose();
  });
  main.addEventListener('click', (event) => {
    const trigger = event.target.closest('.term');
    if (!trigger || (trigger.tagName === 'A' && !(event.detail > 0 && pointerType === 'touch'))) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (active === trigger && pinned) close();
    else show(trigger, true);
  });
  panel.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  panel.addEventListener('pointerleave', waitToClose);
  document.addEventListener('pointerdown', (event) => {
    if (!panel.contains(event.target) && !event.target.closest('.term')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active) {
      if (panel.contains(document.activeElement)) active.focus({ preventScroll: true });
      close();
    }
  });
  window.addEventListener('scroll', close, { passive: true });
  window.addEventListener('resize', close);
  return close;
}
