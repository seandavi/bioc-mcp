import * as z from 'zod';
import { definePrompt } from '../capability';
import { PackageNameSchema } from './package-name';

/** docs_search query the triage prompt prescribes; ranks the propagation gate's rule-by-rule section first. */
export const TRIAGE_DOCS_QUERY = 'propagation gate check verdict';

export const triageFailingPackagePrompt = definePrompt({
  name: 'triage-failing-package',
  title: 'Triage a failing package',
  description:
    'Find out why a Bioconductor package fails to build or check in devel and what should happen next: ' +
    'reads its build state (pkg_status), the failing check output (pkg_check_output) and the infrastructure ' +
    'docs on the propagation gate and runbooks (docs_search, docs_read), then answers what failed, the ' +
    'evidence, the likely cause, where it is documented and the next step.',
  args: z.object({ package: PackageNameSchema }),
  tools: ['pkg_status', 'pkg_check_output', 'docs_search', 'docs_read'],
  render: ({ package: name }) =>
    [
      `Triage the Bioconductor package ${name} in devel (universe "bioc"): what fails, why, and what to do next.`,
      '',
      `1. Call pkg_status with package ${JSON.stringify(name)} and universe "bioc". If it returns not_found, report the error and its suggestions and stop.`,
      '2. Pick one failing job from data.upstream.jobs: its check is ERROR, FAIL or FAILURE and its config is not "bioc-checks" (BiocCheck is advisory and never blocks propagation). Prefer ERROR, because FAIL and FAILURE jobs have no check output, and prefer a linux-* config over the others. If no current job fails but data.upstream.newer_commit_failed.job is set, pick that job: a newer commit failed while the older version is still served. If data.upstream is null or nothing fails, say so, report data.behind and data.behind_reasons, and go to step 4.',
      '3. Call pkg_check_output with universe "bioc" and the job id from that job\'s job field, unchanged. Read data.check.status and data.check.sections. When a section points at another captured file (failing tests at testthat.Rout.fail, a failed install at 00install.out), call pkg_check_output again with that file, taken from data.files. If the job is not_found, or is a "source" job (it holds only pkgdata.txt), try one other failing job; if none can be read, give the job\'s url from pkg_status instead.',
      `4. Call docs_search with query ${JSON.stringify(TRIAGE_DOCS_QUERY)} to find which failing checks block propagation. If the snippets do not settle whether this failure blocks it, call docs_read with the top hit's url. If the failure looks like the infrastructure rather than the package (the runner, the image, a dependency that failed to install, a network download), call docs_search again with a few words naming it, to find the runbook.`,
      '5. Answer under these headings:',
      '   - What failed: the configs and their verdicts, the version and commit, and whether the propagated version is affected (data.propagated, data.behind).',
      '   - Evidence: the decisive lines of the check output, quoted briefly, with the job_url.',
      '   - Likely cause: the package (code, tests, examples, vignettes, dependencies) or the infrastructure, and why. Say so when the evidence does not settle it.',
      '   - Where it is documented: the docs sections you used, each linked by url.',
      '   - Next step: who acts (the maintainer or the infrastructure team) and what they do first.',
      '',
      'Cite the sources each tool returned. Do not guess beyond the evidence.',
    ].join('\n'),
});
