import { describe, expect, test } from 'vitest';
import {
  activitySince,
  actionsStatus,
  ageDays,
  FAILURE_ISSUE_TITLE,
  mergeableFrom,
  prChecksFailing,
  prStatus,
  summarizeRuns,
  truncateTitle,
} from '../../../src/core/ops/rules';
import type { GithubWorkflowRun } from '../../../src/upstreams/github';

describe('actionsStatus', () => {
  test.each([
    ['failure', false, 'fail'],
    ['failure', true, 'warn'],
    ['cancelled', false, 'warn'],
    ['success', false, 'ok'],
    [null, false, 'info'],
    ['timed_out', false, 'fail'],
    ['startup_failure', true, 'warn'],
    ['skipped', false, 'ok'],
    ['neutral', false, 'ok'],
    ['action_required', false, 'warn'],
  ] as const)('(%s, experimental %s) is %s', (conclusion, experimental, expected) => {
    expect(actionsStatus(conclusion, experimental)).toBe(expected);
  });
});

describe('prChecksFailing', () => {
  test('lists failing check runs, then failing statuses, in response order', () => {
    expect(
      prChecksFailing(
        [
          { name: 'test', conclusion: 'success' },
          { name: 'lint', conclusion: 'timed_out' },
        ],
        [
          { context: 'ci/legacy', state: 'error' },
          { context: 'ci/ok', state: 'success' },
        ],
      ),
    ).toEqual(['lint', 'ci/legacy']);
  });

  test('an in-progress run (conclusion null) is not failing', () => {
    expect(prChecksFailing([{ name: 'build', conclusion: null }], [{ context: 'ci/wait', state: 'pending' }])).toEqual([]);
  });

  test.each(['failure', 'timed_out', 'action_required', 'startup_failure', 'FAILURE'])('%s fails a check run', (conclusion) => {
    expect(prChecksFailing([{ name: 'x', conclusion }], [])).toEqual(['x']);
  });

  test.each(['cancelled', 'neutral', 'skipped', 'success'])('%s does not fail a check run', (conclusion) => {
    expect(prChecksFailing([{ name: 'x', conclusion }], [])).toEqual([]);
  });
});

describe('mergeableFrom', () => {
  test('maps REST true, false and null to the GraphQL values', () => {
    expect(mergeableFrom(true)).toBe('MERGEABLE');
    expect(mergeableFrom(false)).toBe('CONFLICTING');
    expect(mergeableFrom(null)).toBe('UNKNOWN');
  });
});

describe('prStatus', () => {
  test('conflicts warn', () => {
    expect(prStatus([], 'CONFLICTING', 1, false)).toEqual({ status: 'warn', reason: 'merge conflicts' });
  });

  test('failing checks warn', () => {
    expect(prStatus(['ci'], 'MERGEABLE', 1, false)).toEqual({ status: 'warn', reason: 'failing checks: ci' });
  });

  test('both problems are joined', () => {
    expect(prStatus(['a', 'b'], 'CONFLICTING', 1, false).reason).toBe('failing checks: a, b; merge conflicts');
  });

  test('a non-draft PR untouched for more than 14 days is info', () => {
    expect(prStatus([], 'MERGEABLE', 15, false)).toEqual({ status: 'info', reason: 'no activity for 15 days' });
  });

  test('14 days exactly is ok; a draft is never stale', () => {
    expect(prStatus([], 'MERGEABLE', 14, false).status).toBe('ok');
    expect(prStatus([], 'MERGEABLE', 15, true)).toEqual({ status: 'ok', reason: 'ok' });
  });

  test('UNKNOWN mergeability is not a problem by itself', () => {
    expect(prStatus([], 'UNKNOWN', 1, false).status).toBe('ok');
  });
});

function run(status: string | null, conclusion: string | null, createdAt: string): GithubWorkflowRun {
  return {
    id: 1,
    status,
    conclusion,
    event: 'push',
    created_at: createdAt,
    html_url: `https://github.com/seandavi/x/actions/runs/${createdAt}`,
    display_title: 't',
  };
}

describe('summarizeRuns', () => {
  test('counts the failure streak and finds the last success', () => {
    const summary = summarizeRuns([
      run('in_progress', null, '2026-10-05'),
      run('completed', 'failure', '2026-10-04'),
      run('completed', 'failure', '2026-10-03'),
      run('completed', 'success', '2026-10-02'),
      run('completed', 'failure', '2026-10-01'),
    ]);
    expect(summary).toEqual({
      latest_conclusion: 'failure',
      latest_run_url: 'https://github.com/seandavi/x/actions/runs/2026-10-04',
      streak: 2,
      last_success_at: '2026-10-02',
      newest_run_at: '2026-10-05',
      runs_examined: 5,
    });
  });

  test('a cancelled run ends the streak', () => {
    const summary = summarizeRuns([
      run('completed', 'failure', '3'),
      run('completed', 'cancelled', '2'),
      run('completed', 'failure', '1'),
    ]);
    expect(summary.streak).toBe(1);
    expect(summary.last_success_at).toBeNull();
  });

  test('no runs gives nulls and a zero streak', () => {
    expect(summarizeRuns([])).toEqual({
      latest_conclusion: null,
      latest_run_url: null,
      streak: 0,
      last_success_at: null,
      newest_run_at: null,
      runs_examined: 0,
    });
  });
});

describe('ageDays', () => {
  const now = new Date('2026-10-22T12:00:00Z');

  test('rounds to one decimal', () => {
    expect(ageDays('2026-10-22T00:00:00Z', now)).toBe(0.5);
    expect(ageDays('2026-10-15T12:00:00Z', now)).toBe(7);
    expect(ageDays('2026-10-21T08:00:00Z', now)).toBe(1.2);
  });
});

describe('activitySince', () => {
  test('is the date seven days before now, so the boundary day is inclusive', () => {
    expect(activitySince(new Date('2026-10-22T12:00:00Z'))).toBe('2026-10-15');
    expect('2026-10-15T00:00:01Z'.slice(0, 10) >= activitySince(new Date('2026-10-22T12:00:00Z'))).toBe(true);
    expect('2026-10-14T23:59:59Z'.slice(0, 10) >= activitySince(new Date('2026-10-22T12:00:00Z'))).toBe(false);
  });
});

describe('truncateTitle', () => {
  test('keeps 80 characters and cuts 81 to 79 plus an ellipsis', () => {
    expect(truncateTitle('a'.repeat(80))).toBe('a'.repeat(80));
    expect(truncateTitle('a'.repeat(81))).toBe(`${'a'.repeat(79)}…`);
  });
});

describe('FAILURE_ISSUE_TITLE', () => {
  test('matches a unit and captures it', () => {
    expect(FAILURE_ISSUE_TITLE.exec('bioc-sync.service is failing')?.[1]).toBe('bioc-sync.service');
  });

  test.each(['bioc-sync is failing', 'Re: bioc-sync.service is failing', 'bioc-sync.service is failing again'])(
    'does not match %j',
    (title) => {
      expect(FAILURE_ISSUE_TITLE.test(title)).toBe(false);
    },
  );
});
