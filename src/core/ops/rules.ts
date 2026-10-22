import type { GithubWorkflowRun } from '../../upstreams/github';
import { THRESHOLDS } from './config';

// The classifications below mirror bioc-infrastructure health/bioc_health/ at commit 223af2a
// (rules.py, sources/issues.py, sources/actions.py, crossref.py). Change both together.

export type HealthStatus = 'ok' | 'info' | 'warn' | 'fail';

const MS_PER_DAY = 86_400_000;

/** bioc-health FAILED_CONCLUSIONS. */
export const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure']);

const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/** bioc-health actions_status. */
export function actionsStatus(conclusion: string | null, experimental: boolean): HealthStatus {
  if (conclusion === null) return 'info';
  if (OK_CONCLUSIONS.has(conclusion)) return 'ok';
  if (FAILED_CONCLUSIONS.has(conclusion)) return experimental ? 'warn' : 'fail';
  return 'warn';
}

const FAILING_CHECK_VERDICTS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/** bioc-health pr_checks_failing over REST: check runs first, then commit statuses, in response order. */
export function prChecksFailing(
  checkRuns: readonly { name: string; conclusion: string | null }[],
  statuses: readonly { context: string; state: string }[],
): string[] {
  const failing = (verdict: string) => FAILING_CHECK_VERDICTS.has(verdict.toUpperCase());
  return [
    ...checkRuns.filter((run) => failing(run.conclusion ?? '')).map((run) => run.name),
    ...statuses.filter((status) => failing(status.state)).map((status) => status.context),
  ];
}

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/** REST mergeable (true | false | null) → the GraphQL value bioc-health stores. */
export function mergeableFrom(value: boolean | null): Mergeable {
  if (value === null) return 'UNKNOWN';
  return value ? 'MERGEABLE' : 'CONFLICTING';
}

/** bioc-health pr_status. Only 'ok' | 'info' | 'warn' occur. */
export function prStatus(
  failingChecks: readonly string[],
  mergeable: Mergeable,
  updatedAgeDays: number,
  isDraft: boolean,
): { status: HealthStatus; reason: string } {
  const problems: string[] = [];
  if (failingChecks.length > 0) problems.push(`failing checks: ${failingChecks.join(', ')}`);
  if (mergeable === 'CONFLICTING') problems.push('merge conflicts');
  if (problems.length > 0) return { status: 'warn', reason: problems.join('; ') };
  if (!isDraft && updatedAgeDays > THRESHOLDS.prStaleDays) {
    return { status: 'info', reason: `no activity for ${Math.round(updatedAgeDays)} days` };
  }
  return { status: 'ok', reason: 'ok' };
}

/** Days between iso and now, rounded to one decimal (bioc-health _age_days). */
export function ageDays(iso: string, now: Date): number {
  return Math.round(((now.getTime() - Date.parse(iso)) / MS_PER_DAY) * 10) / 10;
}

/** First day of the activity window, YYYY-MM-DD (bioc-health `since`). */
export function activitySince(now: Date): string {
  return new Date(now.getTime() - THRESHOLDS.activityWindowDays * MS_PER_DAY).toISOString().slice(0, 10);
}

/** bioc-health _workflow, minus the YAML, schedule and failure evidence. `runs` newest first. */
export function summarizeRuns(runs: readonly GithubWorkflowRun[]): {
  latest_conclusion: string | null; // conclusion of the first run with status 'completed'
  latest_run_url: string | null; // its html_url
  streak: number; // leading completed runs whose conclusion is in FAILED_CONCLUSIONS
  last_success_at: string | null; // created_at of the first completed run with conclusion 'success'
  newest_run_at: string | null; // runs[0].created_at, completed or not
  runs_examined: number; // runs.length (≤ 20)
} {
  const completed = runs.filter((run) => run.status === 'completed');
  let streak = 0;
  for (const run of completed) {
    if (run.conclusion === null || !FAILED_CONCLUSIONS.has(run.conclusion)) break;
    streak++;
  }
  return {
    latest_conclusion: completed[0]?.conclusion ?? null,
    latest_run_url: completed[0]?.html_url ?? null,
    streak,
    last_success_at: completed.find((run) => run.conclusion === 'success')?.created_at ?? null,
    newest_run_at: runs[0]?.created_at ?? null,
    runs_examined: runs.length,
  };
}

/**
 * bioc-health crossref TITLE, with the unit bounded to systemd's name charset and 72 characters in
 * all, because anyone can title an issue in a public repo. Group 1 is the unit.
 */
export const FAILURE_ISSUE_TITLE = /^([A-Za-z0-9:_.@\-]{1,64}\.service) is failing$/;

const TITLE_LIMIT = 80;

/** At most 80 UTF-16 code units: the first 79 plus '…' when longer. */
export function truncateTitle(title: string): string {
  return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 1)}…`;
}
