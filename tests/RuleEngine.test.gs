/**
 * AutoTrash tests — app/RuleEngine.gs (buildQuery, resolveRuleAction,
 * ruleLabel, buildQueue). Stat crediting tests moved to tests/Stats.test.gs.
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

function test_ruleLabel_prefersLabel_thenUppercaseCategory() {
  assertEqual(ruleLabel({ label: 'News', isCategory: true, category: 'social' }), 'News');
  assertEqual(ruleLabel({ isCategory: true, category: 'promotions' }), 'PROMOTIONS');
  assertEqual(ruleLabel({ days: 3 }), '?');
}
// Issue #96: a category rule with isCategory:true but no `category` field
// (CATEGORY_RULES is only validated as parseable JSON, not per-field) used to
// throw TypeError on rule.category.toUpperCase() instead of falling through
// to the '?' every other unlabeled rule gets.
function test_ruleLabel_categoryRuleMissingCategoryField_fallsBackInsteadOfThrowing() {
  assertEqual(ruleLabel({ isCategory: true, enabled: true, days: 30 }), '?');
  assertEqual(ruleLabel({ isCategory: true, category: '' , days: 30 }), '?');
  assertEqual(ruleLabel({ isCategory: true, category: null, days: 30 }), '?');
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
  test_ruleLabel_prefersLabel_thenUppercaseCategory,
  test_ruleLabel_categoryRuleMissingCategoryField_fallsBackInsteadOfThrowing,
  test_buildQueue_order_labelsThenCategoriesThenPurges,
  test_buildQueue_disabledCategoriesExcluded,
  test_buildQueue_categoryRulesFlaggedIsCategory,
  test_buildQueue_purgeRulesUseGlobalPurgeAndInboxPurgeLabels,
  test_buildQueue_offMeansOff,
];
