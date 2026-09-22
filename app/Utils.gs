/**
 * AutoTrash — small shared helpers used across the other backend files.
 * Split out of Code.gs on 2026-09-22; see CLAUDE.md for the full file map.
 */

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function fmtNum(n) { return (n||0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtMs(ms) { return ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's'; }
function safeMail(to, subj, html, plain) {
  // FIX 48 (BUG-C25): guard e.message the same way the rest of the error-
  // reporting path now does (see sendErrorEmail() below) — if GmailApp ever
  // threw something other than a real Error (in principle possible; nothing
  // in JS enforces it), reading .message off it here would be safe only if
  // e itself is non-null. This is the last line of defense for every email
  // this project sends, so it gets the same defensive treatment.
  try { GmailApp.sendEmail(to, subj, plain || subj, { htmlBody: html }); }
  catch (e) { console.error('safeMail failed:', (e && e.message) ? e.message : String(e)); }
}
function ownerEmail() { return Session.getEffectiveUser().getEmail(); }
function getProps()   { return PropertiesService.getUserProperties(); }

// FIX 26 (BUG-E7): Resolve the deployed web app URL for the email link.
// getService().getUrl() only returns a usable /exec address when the script is
// published as a web app; it can return null or throw otherwise, so callers
// receive '' and simply omit the button rather than emitting a dead link.
// No extra OAuth scope needed — ScriptApp is already used for trigger management.
function getAppUrl() {
  try { return ScriptApp.getService().getUrl() || ''; }
  catch (e) { return ''; }
}

