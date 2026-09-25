/**
 * AutoTrash tests — app/EmailSend.gs (sendRunEmail subject-line logic; the
 * dry-run abort subject test lives here too since it's sendRunEmail's
 * subject rule being exercised via abortRun()).
 * Split out of the former monolithic tests/Tests.gs on 2026-09-24 — see
 * CLAUDE.md for the full test-file map and TestFramework.gs for the shared
 * assertions/spies these tests use.
 */

function test_subject_dryRun_saysWouldBeActioned_notActioned() {
  const spy = installGmailSpy([]);
  try {
    sendRunEmail({ totalMoved: 12, totalTrashed: 0, totalArchived: 0, errors: [] }, 1000, 'Dry Run Complete', '#ffbb44', true);
    assert(spy.calls.emails.length === 1, 'expected exactly one email');
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('would be actioned') > -1, 'dry-run subject must say "would be actioned": ' + subj);
    assert(subj.indexOf('[DRY RUN]') === 0, 'dry-run subject must be tagged up front: ' + subj);
  } finally { spy.restore(); }
}
function test_subject_liveRun_saysActioned() {
  const spy = installGmailSpy([]);
  try {
    sendRunEmail({ totalMoved: 12, totalTrashed: 8, totalArchived: 4, errors: [] }, 1000, 'Live Run Complete', '#00ff88', false);
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('actioned') > -1 && subj.indexOf('would') === -1, 'live subject must say actioned, not "would": ' + subj);
  } finally { spy.restore(); }
}
function test_subject_errorsWithZeroMoved_leadsWithErrorLabel() {
  const spy = installGmailSpy([]);
  try {
    sendRunEmail({ totalMoved: 0, totalTrashed: 0, totalArchived: 0, errors: [{ label: 'PROMOTIONS', error: 'quota' }] }, 500, 'Live Run', '#ff4455', false);
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('Error in PROMOTIONS') > -1, 'zero-moved error subject must lead with the failing rule: ' + subj);
  } finally { spy.restore(); }
}
function test_subject_errorsWithSomeMoved_appendsErrorsTag() {
  const spy = installGmailSpy([]);
  try {
    sendRunEmail({ totalMoved: 5, totalTrashed: 5, totalArchived: 0, errors: [{ label: 'X', error: 'boom' }] }, 500, 'Live Run', '#ff4455', false);
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('(errors)') > -1, 'partial-success error subject must flag "(errors)": ' + subj);
  } finally { spy.restore(); }
}
function test_dryRunAbortSubject_saysScannedNotActioned() {
  const spy = installGmailSpy([]);
  try {
    withSavedProps(['SUMMARY_FREQ', 'DAILY_STATS'], props => {
      props.setProperty('SUMMARY_FREQ', 'EACH_RUN');
      abortRun({ totalMoved: 20, dryTrashed: 15, dryArchived: 5 }, 3000, true);
    });
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('scanned') > -1, 'dry-run abort subject must say "scanned": ' + subj);
    assert(subj.indexOf('actioned') === -1, 'dry-run abort subject must not say "actioned": ' + subj);
  } finally { spy.restore(); }
}

// ── sendReportEmail (shared send used by sendRunEmail/sendDailyDigest/abortRun) ──

function test_sendReportEmail_rendersHtmlAndPlainBodiesAndMails() {
  const spy = installGmailSpy([]);
  try {
    sendReportEmail('Subj', 'TITLE', ['line one'], '#00ff88', freshStats(), 1000, false);
    assertEqual(spy.calls.emails.length, 1);
    const e = spy.calls.emails[0];
    assertEqual(e.subj, 'Subj');
    assert(e.opts.htmlBody.indexOf('TITLE') > -1, 'must render buildEmailHtml with the given title');
    assert(e.body.indexOf('line one') > -1, 'plain body must come from plainBody(lines, stats)');
  } finally { spy.restore(); }
}

// ── sendDailyDigest ─────────────────────────────────────────────────────────

function activityStats() {
  return {
    date: '2026-01-01', totalMoved: 500, totalTrashed: 400, totalArchived: 100,
    globalPurgeMoved: 0, globalPurgeTrashed: 0, inboxPurgeMoved: 0, inboxPurgeTrashed: 0,
    labels: { PROMOTIONS: { moved: 500, trashed: 400, archived: 100, finished: true } },
    runs: 10
  };
}

// Issue #98's core repro: an unparseable LAST_DIGEST_DATE used to make
// daysSince NaN, latching `should` at false forever for every freq except
// DAILY — and since the early return fires before LAST_DIGEST_DATE is
// rewritten, the corrupted value was never self-corrected. Now an
// unparseable date must be treated as "never sent" (daysSince = Infinity),
// so the digest fires and heals LAST_DIGEST_DATE on the very next check.
function test_sendDailyDigest_unparseableLastDigestDate_selfHeals() {
  withSavedProps(['SUMMARY_FREQ', 'LAST_DIGEST_DATE', 'DAILY_STATS'], props => {
    props.setProperty('SUMMARY_FREQ', 'WEEKLY');
    props.setProperty('LAST_DIGEST_DATE', 'not-a-date');
    props.setProperty('DAILY_STATS', JSON.stringify(activityStats()));
    const spy = installGmailSpy([]);
    try {
      sendDailyDigest();
      assertEqual(spy.calls.emails.length, 1, 'a corrupted LAST_DIGEST_DATE must not permanently suppress the digest');
      const newDate = props.getProperty('LAST_DIGEST_DATE');
      assert(newDate !== 'not-a-date' && !isNaN(new Date(newDate).getTime()),
        'LAST_DIGEST_DATE must be overwritten with a valid date once the digest actually runs: ' + newDate);
      const d = JSON.parse(props.getProperty('DAILY_STATS'));
      assertEqual(d.runs, 0, 'DAILY_STATS must be reset after a successful digest send');
    } finally { spy.restore(); }
  });
}
// Same corruption, but ALT_DAYS/BIWEEKLY too — every non-DAILY frequency
// used the same NaN comparison and was equally stuck.
function test_sendDailyDigest_unparseableLastDigestDate_healsForEveryFrequency() {
  ['ALT_DAYS', 'WEEKLY', 'BIWEEKLY'].forEach(freq => {
    withSavedProps(['SUMMARY_FREQ', 'LAST_DIGEST_DATE', 'DAILY_STATS'], props => {
      props.setProperty('SUMMARY_FREQ', freq);
      props.setProperty('LAST_DIGEST_DATE', 'garbage');
      props.setProperty('DAILY_STATS', JSON.stringify(activityStats()));
      const spy = installGmailSpy([]);
      try {
        sendDailyDigest();
        assertEqual(spy.calls.emails.length, 1, freq + ': a corrupted date must not suppress the digest');
      } finally { spy.restore(); }
    });
  });
}
function test_sendDailyDigest_freqNever_doesNothing() {
  withSavedProps(['SUMMARY_FREQ', 'LAST_DIGEST_DATE', 'DAILY_STATS'], props => {
    props.setProperty('SUMMARY_FREQ', 'NEVER');
    props.setProperty('LAST_DIGEST_DATE', 'not-a-date');
    props.setProperty('DAILY_STATS', JSON.stringify(activityStats()));
    const spy = installGmailSpy([]);
    try {
      sendDailyDigest();
      assertEqual(spy.calls.emails.length, 0, 'SUMMARY_FREQ NEVER must never send a digest, corrupted date or not');
      assertEqual(props.getProperty('LAST_DIGEST_DATE'), 'not-a-date', 'NEVER must exit before touching LAST_DIGEST_DATE at all');
    } finally { spy.restore(); }
  });
}
function test_sendDailyDigest_belowFrequencyThreshold_doesNotSendYet() {
  withSavedProps(['SUMMARY_FREQ', 'LAST_DIGEST_DATE', 'DAILY_STATS'], props => {
    props.setProperty('SUMMARY_FREQ', 'WEEKLY');
    props.setProperty('LAST_DIGEST_DATE', new Date().toISOString().slice(0, 10)); // sent today
    props.setProperty('DAILY_STATS', JSON.stringify(activityStats()));
    const spy = installGmailSpy([]);
    try {
      sendDailyDigest();
      assertEqual(spy.calls.emails.length, 0, 'a valid, recent LAST_DIGEST_DATE must still gate WEEKLY normally');
    } finally { spy.restore(); }
  });
}
function test_sendDailyDigest_noActivity_updatesDateButSendsNoEmail() {
  withSavedProps(['SUMMARY_FREQ', 'LAST_DIGEST_DATE', 'DAILY_STATS'], props => {
    props.setProperty('SUMMARY_FREQ', 'DAILY');
    props.setProperty('LAST_DIGEST_DATE', '2020-01-01');
    props.deleteProperty('DAILY_STATS');
    const spy = installGmailSpy([]);
    try {
      sendDailyDigest();
      assertEqual(spy.calls.emails.length, 0, 'a zero-run period must not send an empty digest (FIX 16)');
      assertEqual(props.getProperty('LAST_DIGEST_DATE'), new Date().toISOString().slice(0, 10),
        'LAST_DIGEST_DATE must still advance on a no-run day, so tomorrow does not re-check from the same stale date');
    } finally { spy.restore(); }
  });
}

const EMAILSEND_TESTS = [
  test_sendReportEmail_rendersHtmlAndPlainBodiesAndMails,
  test_subject_dryRun_saysWouldBeActioned_notActioned,
  test_subject_liveRun_saysActioned,
  test_subject_errorsWithZeroMoved_leadsWithErrorLabel,
  test_subject_errorsWithSomeMoved_appendsErrorsTag,
  test_dryRunAbortSubject_saysScannedNotActioned,

  test_sendDailyDigest_unparseableLastDigestDate_selfHeals,
  test_sendDailyDigest_unparseableLastDigestDate_healsForEveryFrequency,
  test_sendDailyDigest_freqNever_doesNothing,
  test_sendDailyDigest_belowFrequencyThreshold_doesNotSendYet,
  test_sendDailyDigest_noActivity_updatesDateButSendsNoEmail
];
