import type { Options } from 'minisearch';
import * as z from 'zod';

export const DOCS_FORMAT_VERSION = 1;

export const DocsSourceKindSchema = z.enum(['site', 'adr', 'repo']);
export const DocsRecordSchema = z.object({
  id: z.string().min(1), // 'site:<href>' or 'repo:<repo>/<file>[#<anchor>]'
  url: z.url(), // absolute public URL a person can open
  title: z.string(), // page or document title
  section: z.string(), // section heading; '' for a page/document-level record
  crumbs: z.array(z.string()), // breadcrumb, outermost first
  text: z.string(), // section text (plain for site, Markdown for repo docs)
  source: DocsSourceKindSchema, // 'adr' for site pages under adr/, else 'site'; 'repo' for component docs
  repo: z.string().optional(), // set only when source === 'repo'; key absent otherwise
});
export type DocsRecord = z.infer<typeof DocsRecordSchema>;

export const DocsInputSchema = z.object({
  url: z.string(), // the URL fetched (search.json or a raw file)
  record_count: z.number().int().nonnegative(),
  last_modified: z.string().nullable(), // ISO 8601 from Last-Modified; null when absent
  fetched_at: z.string(), // ISO 8601
  sha256: z.string().regex(/^[0-9a-f]{64}$/), // of the response body (UTF-8)
});
export type DocsInput = z.infer<typeof DocsInputSchema>;

export const DocsIndexMetaSchema = z.object({
  built_at: z.string(), // ISO 8601
  build_commit: z.string().nullable(), // GITHUB_SHA of this repo when built in Actions, else null
  record_count: z.number().int().nonnegative(),
  inputs: z.array(DocsInputSchema), // config order: site first, then repos/files
});
export type DocsIndexMeta = z.infer<typeof DocsIndexMetaSchema>;

/** Records are stored grouped by input, in meta.inputs order: input i owns the next record_count records. */
export const DocsStoreSchema = z.object({
  format_version: z.literal(DOCS_FORMAT_VERSION),
  meta: DocsIndexMetaSchema,
  records: z.array(DocsRecordSchema),
});
export type DocsStore = z.infer<typeof DocsStoreSchema>;

/** Shared by the build and the loader: MiniSearch requires the same options on load. */
export const DOCS_INDEX_OPTIONS = {
  idField: 'id',
  fields: ['title', 'section', 'crumbs', 'text'],
  storeFields: [],
  extractField: (record: DocsRecord, field: string) =>
    field === 'crumbs' ? record.crumbs.join(' ') : (record[field as keyof DocsRecord] as string),
  searchOptions: { boost: { title: 3, section: 2 }, prefix: true, fuzzy: 0.2 },
} satisfies Options<DocsRecord>;
