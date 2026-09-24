/**
 * AutoTrash — test registry + runner. Combines every tests/*.test.gs
 * suite's local TEST_FNS array into one TEST_FNS list and defines
 * runAllTests(), the single entry point used both by the Apps Script
 * editor (Run ▶ runAllTests) and by the Node harness in
 * tests/harness/run-node-tests.js — same function, same logic, two ways
 * to invoke it. See CLAUDE.md for the full test-file map.
 *
 * Split out of the former monolithic tests/Tests.gs on 2026-09-24.
 * Deploy every tests/*.gs file alongside app/*.gs in the same Apps
 * Script project — they share one global scope regardless of file, so
 * load order here doesn't matter.
 */

const TEST_FNS = []
  .concat(TESTFRAMEWORK_TESTS)
  .concat(UTILS_TESTS)
  .concat(RULEENGINE_TESTS)
  .concat(ENGINE_TESTS)
  .concat(EMAILTEMPLATES_TESTS)
  .concat(EMAILSEND_TESTS)
  .concat(CODE_TESTS)
  .concat(RUNNER_TESTS);

function runAllTests() {
  const results = [];
  const t0 = Date.now();

  TEST_FNS.forEach(fn => {
    const name = fn.name || '(anonymous test)';
    const start = Date.now();
    try {
      fn();
      results.push({ name: name, status: 'PASS', ms: Date.now() - start });
    } catch (e) {
      results.push({ name: name, status: 'FAIL', ms: Date.now() - start, error: e.message, stack: e.stack });
    }
  });

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total  = results.length;
  const elapsedMs = Date.now() - t0;

  console.log(`AutoTrash tests: ${passed}/${total} passed (${failed} failed) in ${elapsedMs}ms`);
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`FAIL: ${r.name}\n  ${r.error}\n  ${r.stack || ''}`);
  });

  try {
    const subj = `${failed === 0 ? '✓' : '⚠'} AutoTrash Tests: ${passed}/${total} passed` + (failed ? `, ${failed} FAILED` : '');
    const rows = results.map(r => {
      const color = r.status === 'PASS' ? '#00ff88' : '#ff4455';
      const detail = r.status === 'FAIL' ? `<div style="color:#ff8877;font-size:10px;margin-top:2px;">${(r.error || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>` : '';
      return `<div style="padding:4px 0;font-family:'Courier New',monospace;font-size:12px;color:${color};border-bottom:1px solid #111f11;">
        [${r.status}] ${r.name} <span style="color:#447744;font-size:10px;">(${r.ms}ms)</span>
        ${detail}
      </div>`;
    }).join('');
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#020802;font-family:'Courier New',monospace;">
      <div style="color:#00ff88;font-size:16px;font-weight:bold;">AUTOTRASH TEST REPORT</div>
      <div style="color:#447744;font-size:11px;margin:4px 0 14px;">${new Date().toLocaleString()} · ${passed}/${total} passed · ${elapsedMs}ms total</div>
      <div style="background:#030b03;border:1px solid #1a3a1a;border-radius:4px;padding:10px 14px;">${rows}</div>
    </body></html>`;
    safeMail(ownerEmail(), subj, html, `AutoTrash Tests: ${passed}/${total} passed, ${failed} failed.\n\n` +
      results.map(r => `[${r.status}] ${r.name}${r.error ? ' — ' + r.error : ''}`).join('\n'));
  } catch (e) {
    console.log('runAllTests: failed to send report email: ' + e.message);
  }

  return { passed: passed, failed: failed, total: total, results: results };
}
