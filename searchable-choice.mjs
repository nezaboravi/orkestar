/** Numbered, searchable pages; no terminal-specific dependencies. */
export async function searchableChoice({ items, label = String, recommended = null, question, write, title = 'Model' }) {
  let query = '', page = 0;
  for (;;) {
    const filtered = items.filter(item => label(item).toLowerCase().includes(query.toLowerCase()));
    const visible = filtered.slice(page * 12, (page + 1) * 12);
    write(`\n${title}${query ? ` — matching "${query}"` : ''} (${filtered.length} matches):`);
    write(`  0. Auto${recommended ? ` → ${label(recommended)}` : ' — unavailable'}`);
    visible.forEach((item, index) => write(`  ${index + 1}. ${label(item)}`));
    write('Type a name to search (for example grok), a number to choose, /all to reset, /next or /back for pages.');
    const answer = (await question('Model or search [0]: ')).trim();
    if (answer === '/all') { query = ''; page = 0; continue; }
    if (answer === '/next') { if ((page + 1) * 12 < filtered.length) page++; continue; }
    if (answer === '/back') { page = Math.max(0, page - 1); continue; }
    if (!answer || answer === '0') {
      if (recommended) return { item: recommended, auto: true };
      write('No Auto choice is available. Search or choose a listed model.'); continue;
    }
    if (/^\d+$/.test(answer)) {
      const item = visible[Number(answer) - 1];
      if (item) return { item, auto: false };
      write('Choose a number on this page.'); continue;
    }
    query = answer; page = 0;
  }
}

export async function chooseEffort({levels, fallback, question, write}) {
  write(`  0. Auto (${fallback})`);
  levels.forEach((level,index) => write(`  ${index+1}. ${level}`));
  for (;;) {
    const answer = (await question('Effort [0]: ')).trim().toLowerCase();
    const alias = {l:'low',m:'medium',h:'high'}[answer] || answer;
    if (!answer || answer === '0' || answer === 'auto') return fallback;
    const value = /^\d+$/.test(answer) ? levels[Number(answer)-1] : alias;
    if (levels.includes(value)) return value;
    write('Invalid effort. Choose a listed number; previous choices are kept.');
  }
}
export async function chooseValue({question,write,prompt,values,fallback}) {
  for (;;) {
    const answer = (await question(prompt)).trim().toLowerCase() || fallback;
    if (Object.hasOwn(values,answer)) return values[answer];
    write('Invalid choice. Choose a listed option; previous choices are kept.');
  }
}
