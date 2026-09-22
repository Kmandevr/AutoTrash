/**
 * AutoTrash — email rendering: the ASCII stat chart, plain-text body, HTML
 * escaping, and the full HTML email template. Called by EmailSend.gs.
 * Split out of Code.gs on 2026-09-22; see CLAUDE.md for the full file map.
 */

// ─── ASCII CHART ─────────────────────────────────────────────────────────────
function buildAsciiChart(stats) {
  const BAR = 18;
  const entries = [];
  for (const [k, v] of Object.entries(stats?.labels || {}))
    if ((v.moved || 0) > 0) entries.push({ name: k, t: v.trashed || 0, a: v.archived || 0 });
  if ((stats?.globalPurgeMoved || 0) > 0)
    entries.push({ name: 'GLOBAL PURGE', t: stats.globalPurgeMoved, a: 0 });
  if ((stats?.inboxPurgeMoved || 0) > 0)
    entries.push({ name: 'INBOX PURGE',  t: stats.inboxPurgeMoved,  a: 0 });
  if (!entries.length) return '';

  const maxV = Math.max(...entries.map(e => e.t + e.a), 1);
  const nw   = Math.max(...entries.map(e => e.name.length), 4);
  const sep  = '─'.repeat(nw + BAR + 20);
  const rows = entries.map(e => {
    const tot  = e.t + e.a;
    // FIX 27 (BUG-E8): Clamp non-zero values to at least one block. Anything
    // below ~1/BAR of the largest row used to round to 0 and print a blank row.
    let tb = e.t > 0 ? Math.max(1, Math.round((e.t / maxV) * BAR)) : 0;
    let ab = e.a > 0 ? Math.max(1, Math.round((e.a / maxV) * BAR)) : 0;
    // Clamping can push the pair past BAR; trim the larger side back down so
    // every row stays exactly BAR wide and the columns still line up.
    while (tb + ab > BAR) { if (tb >= ab) tb--; else ab--; }
    const bar  = ('█'.repeat(tb) + '░'.repeat(ab)).padEnd(BAR);
    return `${e.name.padEnd(nw)}  ${bar}  ${fmtNum(tot).padStart(7)}  (█${fmtNum(e.t)} ░${fmtNum(e.a)})`;  // BUG-R6: glyphs match the bar
  });
  return [sep, `${'RULE'.padEnd(nw)}  ${'█=TRASH  ░=ARCHIVE'.padEnd(BAR)}    TOTAL`, sep, ...rows, sep].join('\n');
}

// FIX 35 (S-E4): Plain-text bodies keep the ASCII chart — it is the only
// per-rule view a plain-text reader gets. The HTML body drops it because the
// colour-coded table directly above shows the same numbers.
function plainBody(lines, stats) {
  const chart = buildAsciiChart(stats);
  return (chart ? [...lines, '', chart] : lines).join('\n');
}

// ─── HTML ESCAPE ──────────────────────────────────────────────────────────────
// FIX 44 (BUG-E15): Escapes text that gets interpolated into an HTML email
// body. Needed because Gmail label names (and the rule names derived from
// them) are free-text the user types into the "Label name" field in
// index.html — nothing on the server validates or restricts that text. See
// the escHtml() call inside buildEmailHtml()'s tableRows for the one place
// this closes a gap; BUG-E15 in GitHub Issues has the full story.
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── EMAIL HTML ───────────────────────────────────────────────────────────────
// FIX 21 (BUG-E2): Accepts dryRun flag. Dry-run emails get a prominent
// simulation banner and relabelled stat boxes so they can't be mistaken
// for a real run that actually deleted mail.
function buildEmailHtml(title, lines, accent, stats, elapsedMs, dryRun) {
  const ts   = new Date().toLocaleString();
  const secs = elapsedMs != null ? (elapsedMs / 1000).toFixed(1) : null;
  accent     = accent || '#00ff88';

  // Stat box labels: live vs dry run
  const labelActioned = dryRun ? 'Would Action' : 'Actioned';
  const labelTrashed  = dryRun ? 'Would Trash'  : 'Trashed';
  const labelArchived = dryRun ? 'Would Archive' : 'Archived';

  // Dry-run banner shown above everything else
  const dryBanner = dryRun
    ? `<tr><td style="padding:10px 24px;background:#2a1e00;border-bottom:2px solid #ffbb44;">
        <div class="at-glow" style="font-family:'Courier New',monospace;font-size:13px;font-weight:bold;color:#ffbb44;text-align:center;letter-spacing:1px;">
          ⚠ SIMULATION ONLY — NO MAIL WAS MOVED OR DELETED
        </div>
       </td></tr>`
    : '';

  const allRows = [];
  for (const [k, v] of Object.entries(stats?.labels || {})) {
    if ((v.moved || 0) === 0) continue;
    allRows.push({ name: k, moved: v.moved, t: v.trashed || 0, a: v.archived || 0 });
  }
  if ((stats?.globalPurgeMoved || 0) > 0)
    allRows.push({ name: 'GLOBAL PURGE', moved: stats.globalPurgeMoved, t: stats.globalPurgeMoved, a: 0, special: true });
  if ((stats?.inboxPurgeMoved || 0) > 0)
    allRows.push({ name: 'INBOX PURGE',  moved: stats.inboxPurgeMoved,  t: stats.inboxPurgeMoved,  a: 0, special: true });
  allRows.sort((a, b) => b.moved - a.moved);

  const maxM = Math.max(...allRows.map(r => r.moved), 1);
  const BC   = 12;

  const tableRows = allRows.map(r => {
    // FIX 27 (BUG-E8): Minimum 1 column for any non-zero count. The old
    // rounding sent anything under ~1/BC of the largest row to 0 columns,
    // rendering a solid empty bar. Worst case: a purge rule sets maxM and
    // every ordinary label rule beneath it collapses to nothing.
    let tc = r.t > 0 ? Math.max(1, Math.round((r.t / maxM) * BC)) : 0;
    let ac = r.a > 0 ? Math.max(1, Math.round((r.a / maxM) * BC)) : 0;
    while (tc + ac > BC) { if (tc >= ac) tc--; else ac--; } // never exceed BC
    const ec = Math.max(BC - tc - ac, 0);
    const bar =
      (tc > 0 ? `<td colspan="${tc}" style="background:#ff4455;height:8px;"></td>` : '') +
      (ac > 0 ? `<td colspan="${ac}" style="background:#44aaff;height:8px;"></td>` : '') +
      (ec > 0 ? `<td colspan="${ec}" style="background:#0a180a;height:8px;"></td>` : '');
    const nc = r.special ? '#ffdd88' : '#aaffcc';
    // FIX 44 (BUG-E15): r.name is escHtml()'d — it originates from a Gmail
    // label name the user typed into a free-text field client-side, with no
    // HTML sanitization anywhere on that path. Every other piece of dynamic
    // text in this email (the operation-summary lines below, via logHtml)
    // was already escaped; this row was the one gap that let a label name
    // like `<img src=x onerror=...>` inject markup into the user's own
    // summary/digest email instead of rendering as plain text.
    return `<tr>
      <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:12px;color:${nc};border-bottom:1px solid #111f11;white-space:nowrap;">${escHtml(r.name)}</td>
      <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:12px;color:#fff;text-align:right;border-bottom:1px solid #111f11;white-space:nowrap;">${fmtNum(r.moved)}</td>
      <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:12px;color:#ff8877;text-align:right;border-bottom:1px solid #111f11;white-space:nowrap;">${fmtNum(r.t)}</td>
      <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:12px;color:#88aaff;text-align:right;border-bottom:1px solid #111f11;white-space:nowrap;">${fmtNum(r.a)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #111f11;min-width:70px;">
        <table cellpadding="0" cellspacing="1" width="100%"><tr>${bar}</tr></table>
      </td></tr>`;
  }).join('');

  // FIX 26 (BUG-E7): Link back to the UI so settings are one tap away.
  // Omitted entirely when the script isn't deployed as a web app.
  const appUrl  = getAppUrl();
  const openBtn = appUrl
    ? `<div class="at-fade" style="text-align:center;padding:2px 0 14px;">
         <a href="${appUrl}" style="display:inline-block;font-family:'Courier New',monospace;font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${accent};text-decoration:none;padding:10px 22px;border:1px solid ${accent};border-radius:4px;background:#060d06;">Open AutoTrash &rarr;</a>
       </div>`
    : '';

  // FIX 35 (S-E4): Chart no longer duplicated here. Gmail strips the
  // overflow-x rule on the wrapper, so a chart wider than the 600px shell
  // clipped rather than scrolled — worst with long rule names.
  const allLines = lines;
  const logHtml  = allLines.map(l => {
    const c = l.startsWith('⚠') || l.startsWith('ERROR') ? '#ff6677'
            : l.startsWith('✓') ? '#00ff88'
            // FIX 29 (BUG-E10): #2a5a2a (~2.5:1) failed and #5a7a5a (~4.2:1)
            // was marginal on #010601. Indented lines are the bulk of the body.
            // BUG-E18: dropped the dead '─'/'▓' chart-glyph branch — none of
            // this function's four callers ever pass a line starting with
            // either character (the ASCII chart lives only in plainBody(),
            // never in `lines`), so it never executed.
            : l.startsWith('  ') ? '#88bb99'
            : '#aaffcc';
    return `<div style="padding:1px 0;font-family:'Courier New',monospace;font-size:11px;color:${c};line-height:1.6;white-space:pre;">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  /* FIX 31: Progressive enhancement ONLY. Gmail and Outlook strip <style>
     blocks and ignore @keyframes entirely — those clients render the static
     inline styles exactly as before, with no visual change whatsoever.
     animation-fill-mode is deliberately NOT set: with 'both', a client that
     keeps the stylesheet but blocks animations would leave elements stuck at
     opacity:0 — an invisible email. Without it the worst case is no animation. */
  @keyframes atFade { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @keyframes atGlow { 0%,100% { opacity:1; } 50% { opacity:.7; } }
  .at-fade { animation:atFade .5s ease; }
  .at-d1   { animation:atFade .5s ease .06s; }
  .at-d2   { animation:atFade .5s ease .12s; }
  .at-d3   { animation:atFade .5s ease .18s; }
  .at-glow { animation:atGlow 2.4s ease-in-out infinite; }
</style></head>
<body style="margin:0;padding:0;background:#020802;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#020802;">
<tr><td align="center" style="padding:24px 12px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
${dryBanner}
<tr><td style="background:#050e05;border:1px solid #1a3a1a;border-radius:6px 6px 0 0;padding:20px 24px 16px;border-bottom:3px solid ${accent};">
  <div style="font-family:'Courier New',monospace;font-size:9px;color:#336633;letter-spacing:3px;text-transform:uppercase;margin-bottom:5px;">AUTOTRASH v26 // OPS REPORT</div>
  <div style="font-family:'Courier New',monospace;font-size:19px;font-weight:bold;color:${accent};">${title}</div>
  <div style="font-family:'Courier New',monospace;font-size:10px;color:#447744;margin-top:4px;">${ts}</div>
</td></tr>
<tr><td style="background:#030b03;border:1px solid #1a3a1a;border-top:none;border-radius:0 0 6px 6px;padding:20px 24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-collapse:separate;border-spacing:4px;">
  <tr>
    <td style="padding:12px 8px;background:#060d06;border:1px solid #1a3a1a;border-top:3px solid ${accent};border-radius:4px;text-align:center;">
      <div class="at-d1" style="font-family:'Courier New',monospace;font-size:26px;font-weight:bold;color:${accent};">${fmtNum(stats?.totalMoved || 0)}</div>
      <div style="font-family:'Courier New',monospace;font-size:8px;color:#447744;text-transform:uppercase;letter-spacing:1.5px;margin-top:3px;">${labelActioned}</div>
    </td>
    <td style="padding:12px 8px;background:#060d06;border:1px solid #1a3a1a;border-top:3px solid #ff4455;border-radius:4px;text-align:center;">
      <div class="at-d2" style="font-family:'Courier New',monospace;font-size:26px;font-weight:bold;color:#ff8877;">${fmtNum(stats?.totalTrashed || 0)}</div>
      <div style="font-family:'Courier New',monospace;font-size:8px;color:#447744;text-transform:uppercase;letter-spacing:1.5px;margin-top:3px;">${labelTrashed}</div>
    </td>
    <td style="padding:12px 8px;background:#060d06;border:1px solid #1a3a1a;border-top:3px solid #44aaff;border-radius:4px;text-align:center;">
      <div class="at-d3" style="font-family:'Courier New',monospace;font-size:26px;font-weight:bold;color:#88aaff;">${fmtNum(stats?.totalArchived || 0)}</div>
      <div style="font-family:'Courier New',monospace;font-size:8px;color:#447744;text-transform:uppercase;letter-spacing:1.5px;margin-top:3px;">${labelArchived}</div>
    </td>
  </tr>
  </table>
  ${secs ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">
  <tr><td style="padding:9px 12px;background:#060d06;border:1px solid #1a3a1a;border-radius:4px;">
    <span style="font-family:'Courier New',monospace;font-size:10px;color:#447744;">DURATION </span>
    <span style="font-family:'Courier New',monospace;font-size:12px;color:#aaffcc;">${secs}s</span>
    ${(stats?.totalMoved || 0) > 0 && parseFloat(secs) > 0
      ? `<span style="font-family:'Courier New',monospace;font-size:10px;color:#447744;"> · AVG </span>
         <span style="font-family:'Courier New',monospace;font-size:12px;color:#aaffcc;">${fmtNum(Math.round((stats.totalMoved||0)/parseFloat(secs)))}/sec</span>`
      : ''}
  </td></tr></table>` : ''}
  ${tableRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-collapse:collapse;background:#040c04;border:1px solid #1a3a1a;border-radius:4px;overflow:hidden;">
  <tr style="background:#091509;">
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#336633;text-transform:uppercase;letter-spacing:1.2px;">Rule</td>
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#336633;text-transform:uppercase;letter-spacing:1.2px;text-align:right;">Total</td>
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#ff6655;text-transform:uppercase;letter-spacing:1.2px;text-align:right;">Trash</td>
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#6699ff;text-transform:uppercase;letter-spacing:1.2px;text-align:right;">Archive</td>
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#336633;text-transform:uppercase;letter-spacing:1.2px;">Split (red=trash · blue=archive)</td>
  </tr>
  ${tableRows}
  </table>` : ''}
  <div style="background:#010601;border:1px solid #0f1f0f;border-radius:3px;padding:12px 14px;margin-bottom:12px;overflow-x:auto;">
    <div style="font-family:'Courier New',monospace;font-size:9px;color:#336633;letter-spacing:2px;text-transform:uppercase;margin-bottom:7px;">OPERATION SUMMARY</div>
    ${logHtml}
  </div>
  ${openBtn}
  <div style="padding-top:10px;border-top:1px solid #0d1d0d;font-family:'Courier New',monospace;font-size:9px;color:#253525;text-align:center;">
    AUTOTRASH v26 · Safety-first email automation · ${ts}
  </div>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

