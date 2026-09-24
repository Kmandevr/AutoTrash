/**
 * AutoTrash tests — app/RuleEngine.gs (buildQuery, resolveRuleAction,
 * buildQueue, ensureStat, creditStat).
 * Split out of the former monolithic tests/Tests.gs on 2026-09-24 — see
 * CLAUDE.md for the full test-file map and TestFramework.gs for the shared
 * assertions/spies these tests use.
 */

function test_buildQuery_labelRule() {
  assertEqual(
    buildQuery({ label: 'Newsletters', days: 30, isTrash: true }),
    'label:"Newsletters" in:inbox older_than:30d -is:starred -in:trash'
  );
}
function test_buildQuery_labelRuleWithSpaces() {
  assertEqual(
    buildQuery({ label: 'Old Receipts', days: 10 }),
    'label:"Old Receipts" in:inbox older_than:10d -is:starred -in:trash'
  );
}
function test_buildQuery_category() {
  assertEqual(
    buildQuery({ isCategory: true, category: 'promotions', days: 30 }),
    'category:promotions in:inbox older_than:30d -is:starred -in:trash'
  );
}
function test_buildQuery_spamCategory_usesInSpamNotCategoryTab() {
  assertEqual(
    buildQuery({ isCategory: true, category: 'spam', days: 7 }),
    'in:spam older_than:7d -is:starred -in:trash'
  );
}
function test_buildQuery_inboxPurge_scopedToInbox_noRedundantTrashClause() {
  const q = buildQuery({ isInboxPurge: true, days: 90 });
  assertEqual(q, 'in:inbox older_than:90d -is:starred');
  assert(!q.includes('-in:trash'), 'inbox purge query must not carry a redundant -in:trash');
}
function test_buildQuery_globalPurge_allMailScope_excludesTrashAndSpam() {
  const q = buildQuery({ isGlobalPurge: true, days: 365 });
  assertEqual(q, 'older_than:365d -is:starred -in:trash -in:spam');
  assert(!q.includes('in:inbox'), 'global purge must reach archived mail — no in:inbox scope');
}
function test_buildQuery_allRuleTypes_spareStarredMail() {
  const rules = [
    { label: 'A', days: 1 },
    { isCategory: true, category: 'social', days: 1 },
    { isCategory: true, category: 'spam', days: 1 },
    { isInboxPurge: true, days: 1 },
    { isGlobalPurge: true, days: 1 }
  ];
  rules.forEach(r => assert(buildQuery(r).includes('-is:starred'), 'missing -is:starred in: ' + JSON.stringify(r)));
}

function test_buildQuery_labelWithEmbeddedQuote_doesNotBreakOutOfQuotedTerm() {
  const q = buildQuery({ label: 'Foo"Bar', days: 5 });
  assertEqual(q, 'label:"FooBar" in:inbox older_than:5d -is:starred -in:trash');
  assertEqual((q.match(/"/g) || []).length, 2, 'query must contain exactly one quoted phrase (2 quote chars)');
}
function test_buildQuery_labelWithoutQuotes_unaffectedByFix() {
  assertEqual(
    buildQuery({ label: 'Receipts', days: 5 }),
    'label:"Receipts" in:inbox older_than:5d -is:starred -in:trash'
  );
}

function test_buildQuery_labelAllQuoteCharacters_producesEmptyQuotedTerm() {
  const q = buildQuery({ label: '""', days: 5 });
  assertEqual(q, 'label:"" in:inbox older_than:5d -is:starred -in:trash');
}

function test_buildQuery_negativeDays_isNotValidatedOrClamped() {
  const q = buildQuery({ isCategory: true, category: 'promotions', days: -5 });
  assertEqual(q, 'category:promotions in:inbox older_than:-5d -is:starred -in:trash');
}

function test_resolveRuleAction_explicitTrash() {
  assertEqual(resolveRuleAction({ isTrash: true }), 'trash');
}
function test_resolveRuleAction_explicitArchive() {
  assertEqual(resolveRuleAction({ isTrash: false }), 'archive');
}
function test_resolveRuleAction_undefinedDefaultsToTrash() {
  assertEqual(resolveRuleAction({}), 'trash');
}
function test_resolveRuleAction_nullDefaultsToTrash() {
  assertEqual(resolveRuleAction({ isTrash: null }), 'trash');
}
function test_resolveRuleAction_globalPurgeAlwaysTrash_ignoresIsTrash() {
  assertEqual(resolveRuleAction({ isGlobalPurge: true, isTrash: false }), 'trash');
}
function test_resolveRuleAction_inboxPurgeAlwaysTrash_ignoresIsTrash() {
  assertEqual(resolveRuleAction({ isInboxPurge: true, isTrash: false }), 'trash');
}

function test_buildQueue_order_labelsThenCategoriesThenPurges() {
  const q = buildQueue(
    [{ label: 'A', days: 1 }, { label: 'B', days: 2 }],
    '365', '30',
    [{ category: 'social', enabled: true, days: 60 }, { category: 'updates', enabled: false, days: 30 }]
  );
  assertEqual(q.map(r => r.label || r.category), ['A', 'B', 'social', 'INBOX PURGE', 'GLOBAL PURGE']);
}
function test_buildQueue_disabledCategoriesExcluded() {
  const q = buildQueue([], 'OFF', 'OFF', [{ category: 'forums', enabled: false, days: 60 }]);
  assertEqual(q.length, 0);
}
function test_buildQueue_categoryRulesFlaggedIsCategory() {
  const q = buildQueue([], 'OFF', 'OFF', [{ category: 'social', enabled: true, days: 60 }]);
  assert(q[0].isCategory === true, 'buildQueue must set isCategory:true on category entries');
}
function test_buildQueue_purgeRulesUseGlobalPurgeAndInboxPurgeLabels() {
  const q = buildQueue([], '365', '90', []);
  assertEqual(q.map(r => r.label), ['INBOX PURGE', 'GLOBAL PURGE']);
}
function test_buildQueue_offMeansOff() {
  const q = buildQueue([{ label: 'A', days: 1 }], 'OFF', 'OFF', []);
  assertEqual(q.length, 1);
}

function test_ensureStat_createsZeroedEntryOnce() {
  const stats = { labels: {} };
  ensureStat(stats, 'X');
  ensureStat(stats, 'X');
  stats.labels.X.moved = 5;
  ensureStat(stats, 'X');
  assertEqual(stats.labels.X.moved, 5, 'ensureStat must not overwrite an existing entry');
}
function test_creditStat_normalRuleGoesToLabels() {
  const stats = { labels: {} };
  creditStat(stats, 'PROMOTIONS', {}, 5, 2);
  assertEqual(stats.labels.PROMOTIONS, { moved: 7, trashed: 5, archived: 2, finished: false });
}
function test_creditStat_globalPurge_bypassesLabels() {
  const stats = { labels: {}, globalPurgeMoved: 0, globalPurgeTrashed: 0 };
  creditStat(stats, 'GLOBAL PURGE', { isGlobalPurge: true }, 10, 0);
  assertEqual([stats.globalPurgeMoved, stats.globalPurgeTrashed], [10, 10]);
  assert(!stats.labels['GLOBAL PURGE'], 'global purge must not create a stats.labels entry');
}
function test_creditStat_inboxPurge_bypassesLabels() {
  const stats = { labels: {}, inboxPurgeMoved: 0, inboxPurgeTrashed: 0 };
  creditStat(stats, 'INBOX PURGE', { isInboxPurge: true }, 4, 0);
  assertEqual([stats.inboxPurgeMoved, stats.inboxPurgeTrashed], [4, 4]);
  assert(!stats.labels['INBOX PURGE'], 'inbox purge must not create a stats.labels entry');
}
function test_creditStat_accumulatesAcrossMultipleCalls() {
  const stats = { labels: {} };
  creditStat(stats, 'A', {}, 3, 0);
  creditStat(stats, 'A', {}, 2, 1);
  assertEqual(stats.labels.A, { moved: 6, trashed: 5, archived: 1, finished: false });
}

const RULEENGINE_TESTS = [
  test_buildQuery_labelRule,
  test_buildQuery_labelRuleWithSpaces,
  test_buildQuery_category,
  test_buildQuery_spamCategory_usesInSpamNotCategoryTab,
  test_buildQuery_inboxPurge_scopedToInbox_noRedundantTrashClause,
  test_buildQuery_globalPurge_allMailScope_excludesTrashAndSpam,
  test_buildQuery_allRuleTypes_spareStarredMail,
  test_buildQuery_labelWithEmbeddedQuote_doesNotBreakOutOfQuotedTerm,
  test_buildQuery_labelWithoutQuotes_unaffectedByFix,
  test_buildQuery_labelAllQuoteCharacters_producesEmptyQuotedTerm,
  test_buildQuery_negativeDays_isNotValidatedOrClamped,
  test_resolveRuleAction_explicitTrash,
  test_resolveRuleAction_explicitArchive,
  test_resolveRuleAction_undefinedDefaultsToTrash,
  test_resolveRuleAction_nullDefaultsToTrash,
  test_resolveRuleAction_globalPurgeAlwaysTrash_ignoresIsTrash,
  test_resolveRuleAction_inboxPurgeAlwaysTrash_ignoresIsTrash,
  test_buildQueue_order_labelsThenCategoriesThenPurges,
  test_buildQueue_disabledCategoriesExcluded,
  test_buildQueue_categoryRulesFlaggedIsCategory,
  test_buildQueue_purgeRulesUseGlobalPurgeAndInboxPurgeLabels,
  test_buildQueue_offMeansOff,
  test_ensureStat_createsZeroedEntryOnce,
  test_creditStat_normalRuleGoesToLabels,
  test_creditStat_globalPurge_bypassesLabels,
  test_creditStat_inboxPurge_bypassesLabels,
  test_creditStat_accumulatesAcrossMultipleCalls
];
