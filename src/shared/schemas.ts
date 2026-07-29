import { z } from 'zod';

export const visibilitySchema = z.enum(['public', 'unlisted', 'private']);
export const repositoryKeySchema = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/);
export const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,94}[a-z0-9])?$/);

export const loginSchema = z.object({ password: z.string().min(1).max(512) });
export const repositoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  key: repositoryKeySchema,
  visibility: visibilitySchema,
});
export const repositoryUpdateSchema = repositoryCreateSchema.partial().refine((value) => Object.keys(value).length > 0);
export const categoryCreateSchema = z.object({
  repositoryId: z.string().uuid(),
  parentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120),
});
export const postCreateSchema = z.object({
  repositoryId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).default('未命名'),
  language: z.string().trim().min(2).max(35).default('zh-CN'),
});
export const postSaveSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  title: z.string().trim().max(240),
  slug: slugSchema.or(z.literal('')),
  repositoryId: z.string().uuid(),
  categoryId: z.string().uuid().nullable(),
  language: z.string().trim().min(2).max(35),
  summary: z.string().max(2000).nullable(),
  markdown: z.string().max(2_000_000),
  tags: z.array(z.string().trim().min(1).max(80)).max(80),
  featured: z.boolean(),
  coverAssetId: z.string().uuid().nullable(),
  customProperties: z.record(z.string(), z.unknown()),
});
export const scheduleSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  localDateTime: z.string(),
  timezone: z.string().min(1).max(80),
  utcDateTime: z.string().datetime({ offset: true }),
});

export const reservedRepositoryKeys = new Set([
  'manage', 'api', 'feed.xml', 'sitemap.xml', 'robots.txt', 'assets', 'fonts', 'favicon.ico', 'media',
]);

