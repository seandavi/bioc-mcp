import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import { bioconductorUpstream } from './bioconductor';
import { fetchUpstream, pathSegment, type UpstreamResponse, type UpstreamResponseMeta } from './http';
import type { Universe } from './registry';
import { SharedLoads } from './shared-load';

/** BBS names its reports by branch: universe 'bioc' is the devel report, 'bioc-release' the release one. */
export const BBS_REPORTS = { bioc: 'devel', 'bioc-release': 'release' } as const satisfies Record<Universe, string>;
export type BbsReport = (typeof BBS_REPORTS)[Universe];

/** BBS builds with a propagation file, in search order; software first. */
export const BBS_BUILDS = ['bioc', 'data-experiment', 'workflows', 'books'] as const;
export type BbsBuild = (typeof BBS_BUILDS)[number];

export const BBS_BASE_PATH = 'checkResults/';

const upstreamDetails = (url: string) => ({ upstream: bioconductorUpstream.id, url });

/** 'checkResults/{report}/{build}-LATEST/'; report and build are constants. */
export function bbsReportPath(report: BbsReport, build: BbsBuild): string {
  return `${BBS_BASE_PATH}${report}/${build}-LATEST/`;
}

/** bbsReportPath + pathSegment(name) + '/': the package's report page. */
export function bbsPackagePath(report: BbsReport, build: BbsBuild, name: string): string {
  return `${bbsReportPath(report, build)}${pathSegment(name)}/`;
}

/** Absolute URL of a stage's log page: {package page}{pathSegment(`${node}-${stage}.html`)}. Built, never fetched. */
export function bbsStageUrl(report: BbsReport, build: BbsBuild, name: string, node: string, stage: string): string {
  return new URL(
    `${bbsPackagePath(report, build, name)}${pathSegment(`${node}-${stage}.html`)}`,
    bioconductorUpstream.baseUrl,
  ).href;
}

/** bbsReportPath + pathSegment(`${node}-NodeInfo.html`): the build machine's page, shared by every package. */
export function bbsNodeInfoPath(report: BbsReport, build: BbsBuild, node: string): string {
  return `${bbsReportPath(report, build)}${pathSegment(`${node}-NodeInfo.html`)}`;
}

export interface BbsStageResult {
  node: string; // e.g. 'nebbiolo2'
  stage: string; // 'install' | 'buildsrc' | 'checksrc' | 'buildbin' as observed; not enforced
  status: string; // 'OK' | 'WARNINGS' | 'ERROR' | 'TIMEOUT' | 'skipped' | 'NA' as observed; not enforced
}

export interface BbsBuildStatus {
  response: UpstreamResponseMeta; // for sourceFor(); the body is dropped once parsed
  packages: ReadonlyMap<string, readonly BbsStageResult[]>; // package → its lines, in file order
}

export interface BbsPropagation {
  target: string; // 'source', 'mac.binary.big-sur-x86_64', … as observed
  status: string; // 'YES' | 'NO' | 'UNNEEDED' as observed; not enforced
  reason: string | null; // text after ', ', e.g. "same version is already published"
}

export interface BbsPropagationStatus {
  response: UpstreamResponseMeta;
  packages: ReadonlyMap<string, readonly BbsPropagation[]>; // package → its lines, in file order
}

export interface BbsPackageInfo {
  response: UpstreamResponseMeta;
  version: string;
  commit: { id: string; time: string | null; branch: string | null } | null;
}

export interface BbsNodeSpec {
  os: string; // e.g. 'Linux (Ubuntu 24.04.4 LTS)', 'macOS 12.7.6 Monterey'
  arch: string; // e.g. 'x86_64', 'aarch64'
}

export interface BbsNodeInfo {
  response: UpstreamResponseMeta;
  spec: BbsNodeSpec | null; // null when the page names another host or lacks OS or Arch
}

function withoutBody(response: UpstreamResponse): UpstreamResponseMeta {
  const { body: _body, ...meta } = response;
  return meta;
}

const BLANK_LINE = /^\s*$/;
const BUILD_STATUS_LINE = /^([A-Za-z][A-Za-z0-9.]*)#([A-Za-z0-9_.-]+)#([A-Za-z]+): (\S+)$/;
const PROPAGATION_LINE = /^([A-Za-z][A-Za-z0-9.]*)#([^#\s]+)#propagate: ([A-Za-z]+)(?:, (.+))?$/;

/** BUILD_STATUS_DB.txt: package → its `package#node#stage: status` lines, in file order. */
export function parseBuildStatusDb(body: string, url: string): Map<string, BbsStageResult[]> {
  const malformed = () =>
    new CapabilityError(
      'upstream_error',
      `bioconductor.org returned a BBS build status file in an unexpected format (${url})`,
      upstreamDetails(url),
    );
  const packages = new Map<string, BbsStageResult[]>();
  const keys = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    if (BLANK_LINE.test(line)) continue;
    const match = BUILD_STATUS_LINE.exec(line);
    if (!match) throw malformed();
    const [, name, node, stage, status] = match as unknown as [string, string, string, string, string];
    const key = `${name}#${node}#${stage}`;
    if (keys.has(key)) throw malformed();
    keys.add(key);
    const results = packages.get(name);
    if (results) results.push({ node, stage, status });
    else packages.set(name, [{ node, stage, status }]);
  }
  return packages;
}

/** PROPAGATION_STATUS_DB.txt: package → its `package#target#propagate: status[, reason]` lines, in file order. */
export function parsePropagationStatusDb(body: string, url: string): Map<string, BbsPropagation[]> {
  const packages = new Map<string, BbsPropagation[]>();
  for (const line of body.split(/\r?\n/)) {
    if (BLANK_LINE.test(line)) continue;
    const match = PROPAGATION_LINE.exec(line);
    if (!match) {
      throw new CapabilityError(
        'upstream_error',
        `bioconductor.org returned a BBS propagation status file in an unexpected format (${url})`,
        upstreamDetails(url),
      );
    }
    const row = { target: match[2]!, status: match[3]!, reason: match[4] ?? null };
    const rows = packages.get(match[1]!);
    if (rows) rows.push(row);
    else packages.set(match[1]!, [row]);
  }
  return packages;
}

// dotAll and no `m` flag, as in packages-file.ts: nothing backtracks.
const DCF_FIELD = /^([^\s:]+):(.*)$/s;
const VERSION_FORMAT = /^\d+([.-]\d+)*$/;
const COMMIT_ID = /^[0-9a-f]{7,40}$/;

/** One info.dcf stanza; Maintainer and MaintainerEmail are never read. */
export function parseBbsInfoDcf(body: string, name: string, url: string): Pick<BbsPackageInfo, 'version' | 'commit'> {
  const malformed = () =>
    new CapabilityError(
      'upstream_error',
      `bioconductor.org returned a BBS info.dcf in an unexpected format (${url})`,
      upstreamDetails(url),
    );
  const fields = new Map<string, string>();
  let lastField: string | undefined;
  let ended = false;
  for (const line of body.split(/\r?\n/)) {
    if (BLANK_LINE.test(line)) {
      ended = true;
    } else if (ended) {
      throw malformed();
    } else if (line.startsWith(' ') || line.startsWith('\t')) {
      if (lastField === undefined) throw malformed();
    } else {
      const match = DCF_FIELD.exec(line);
      if (!match) throw malformed();
      lastField = match[1]!;
      if (!fields.has(lastField)) fields.set(lastField, match[2]!.trim());
    }
  }

  const actual = fields.get('Package');
  if (actual === undefined) throw malformed();
  if (actual !== name) {
    throw new CapabilityError(
      'upstream_error',
      `bioconductor.org returned info.dcf for "${actual}" at ${url}, expected "${name}"`,
      upstreamDetails(url),
    );
  }
  const version = fields.get('Version');
  if (version === undefined || !VERSION_FORMAT.test(version)) throw malformed();

  const id = fields.get('git_last_commit');
  if (id === undefined || !COMMIT_ID.test(id)) return { version, commit: null };
  return {
    version,
    commit: {
      id,
      time: bbsCommitTime(fields.get('git_last_commit_date') ?? ''),
      branch: fields.get('git_branch') || null,
    },
  };
}

const COMMIT_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})\b/;

/** '2026-04-28 08:35:24 -0400 (Tue, 28 Apr 2026)' → '2026-04-28T08:35:24-04:00'; null if it does not parse. */
export function bbsCommitTime(value: string): string | null {
  const match = COMMIT_TIME.exec(value);
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

const nodeInfoField = (label: string) =>
  new RegExp(`<TD><B>${label}:(?:&nbsp;|\\s)*<\\/B><\\/TD>\\s*<TD>([\\s\\S]*?)<\\/TD>`, 'i');
const NODE_HOSTNAME = nodeInfoField('Hostname');
const NODE_OS = nodeInfoField('OS');
const NODE_ARCH = nodeInfoField('Arch');

function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** OS and Arch from a build machine's NodeInfo page; null if it names another host or lacks either. Never throws. */
export function parseBbsNodeInfo(html: string, node: string): BbsNodeSpec | null {
  const cell = (pattern: RegExp) => {
    const match = pattern.exec(html);
    return match ? cellText(match[1]!) : '';
  };
  const os = cell(NODE_OS);
  const arch = cell(NODE_ARCH);
  if (cell(NODE_HOSTNAME) !== node || os === '' || arch === '') return null;
  return { os, arch };
}

const buildStatuses = new SharedLoads<BbsBuildStatus>();
const propagationStatuses = new SharedLoads<BbsPropagationStatus>();

/** GET the file; a 404 becomes upstream_error naming `missing` ("has no BBS … file"). */
async function fetchReportFile(deps: Deps, path: string, url: string, missing: string): Promise<UpstreamResponse> {
  try {
    return await fetchUpstream(deps, bioconductorUpstream, path);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') {
      throw new CapabilityError('upstream_error', `bioconductor.org has no ${missing} at ${url}`, upstreamDetails(url));
    }
    throw error;
  }
}

/** GET BUILD_STATUS_DB.txt of a report build, parsed once per cache TTL. An empty file is upstream_error. */
export function getBbsBuildStatus(deps: Deps, report: BbsReport, build: BbsBuild): Promise<BbsBuildStatus> {
  const path = `${bbsReportPath(report, build)}BUILD_STATUS_DB.txt`;
  const url = new URL(path, bioconductorUpstream.baseUrl).href;
  return buildStatuses.get(deps, bioconductorUpstream, url, 'the BBS build status file', async () => {
    const response = await fetchReportFile(deps, path, url, 'BBS build status file');
    const packages = parseBuildStatusDb(response.body, url);
    if (packages.size === 0) {
      throw new CapabilityError(
        'upstream_error',
        `bioconductor.org returned a BBS build status file with no packages (${url})`,
        upstreamDetails(url),
      );
    }
    return { response: withoutBody(response), packages };
  });
}

/** GET PROPAGATION_STATUS_DB.txt of a report build, parsed once per cache TTL. An empty file is allowed. */
export function getBbsPropagationStatus(deps: Deps, report: BbsReport, build: BbsBuild): Promise<BbsPropagationStatus> {
  const path = `${bbsReportPath(report, build)}PROPAGATION_STATUS_DB.txt`;
  const url = new URL(path, bioconductorUpstream.baseUrl).href;
  return propagationStatuses.get(deps, bioconductorUpstream, url, 'the BBS propagation status file', async () => {
    const response = await fetchReportFile(deps, path, url, 'BBS propagation status file');
    return { response: withoutBody(response), packages: parsePropagationStatusDb(response.body, url) };
  });
}

/** GET the package's raw-results/info.dcf; undefined on 404. */
export async function getBbsPackageInfo(
  deps: Deps,
  report: BbsReport,
  build: BbsBuild,
  name: string,
): Promise<BbsPackageInfo | undefined> {
  let response: UpstreamResponse;
  try {
    response = await fetchUpstream(deps, bioconductorUpstream, `${bbsPackagePath(report, build, name)}raw-results/info.dcf`);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') return undefined;
    throw error;
  }
  return { response: withoutBody(response), ...parseBbsInfoDcf(response.body, name, response.url) };
}

/** GET a build machine's NodeInfo page; undefined on 404. */
export async function getBbsNodeInfo(
  deps: Deps,
  report: BbsReport,
  build: BbsBuild,
  node: string,
): Promise<BbsNodeInfo | undefined> {
  let response: UpstreamResponse;
  try {
    response = await fetchUpstream(deps, bioconductorUpstream, bbsNodeInfoPath(report, build, node));
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') return undefined;
    throw error;
  }
  return { response: withoutBody(response), spec: parseBbsNodeInfo(response.body, node) };
}
