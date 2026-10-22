// Copied from bioc-infrastructure health/config.toml (owner, repos, experimental_repos,
// failure_issue_repo, activity_window_days, [thresholds]), plus bioc-mcp.

export const OPS_OWNER = 'seandavi';

/** Order is the output order. bioc-health's list plus bioc-mcp. */
export const OPS_REPOS = [
  'bioc-edge',
  'bioc-traffic',
  'bioc-infrastructure',
  'bioc-registry',
  'bioc-website',
  'bioc-build',
  'bioc-manifest',
  'bioc-intelligence',
  'bioc-mcp',
] as const;
export type OpsRepo = (typeof OPS_REPOS)[number];

/** Prototypes: an Actions failure caps at 'warn' (bioc-health experimental_repos). */
export const EXPERIMENTAL_REPOS: ReadonlySet<OpsRepo> = new Set(['bioc-build', 'bioc-manifest']);

/** Where bioc-notify@ (bioc-edge/notify-failure.sh) files "<unit> is failing" issues. */
export const FAILURE_ISSUE_REPO: OpsRepo = 'bioc-edge';

export const THRESHOLDS = {
  prStaleDays: 14,
  issueStaleDays: 30,
  activityWindowDays: 7,
  runsPerWorkflow: 20, // bioc-health: gh run list -L 20
} as const;

export const OPS_KINDS = ['summary', 'issues', 'prs', 'workflows', 'failures'] as const;
export type OpsKind = (typeof OPS_KINDS)[number];

export const ISSUE_ITEM_LIMIT = 15;
export const PR_ITEM_LIMIT = 10;
export const WORKFLOW_ITEM_LIMIT = 12;
export const FAILURE_ITEM_LIMIT = 15;
export const SUMMARY_PROBLEM_LIMIT = 5; // workflows named in the summary text
