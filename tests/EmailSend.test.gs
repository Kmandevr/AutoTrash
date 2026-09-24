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

const EMAILSEND_TESTS = [
  test_subject_dryRun_saysWouldBeActioned_notActioned,
  test_subject_liveRun_saysActioned,
  test_subject_errorsWithZeroMoved_leadsWithErrorLabel,
  test_subject_errorsWithSomeMoved_appendsErrorsTag,
  test_dryRunAbortSubject_saysScannedNotActioned
];
