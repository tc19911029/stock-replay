/**
 * Centralized environment variable validation.
 *
 * Import this module in server-side code to ensure all required
 * environment variables are present. Missing variables throw
 * a clear error at startup rather than silently failing later.
 */

import { z } from 'zod';

const envSchema = z.object({
  // Required — will throw if missing
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // Optional — have defaults or are only needed for specific features
  FINMIND_API_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('onboarding@resend.dev'),
  NOTIFY_EMAIL: z.string().email().optional(),
  CRON_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _validated: Env | null = null;

/** Validated environment variables (lazy-parsed on first access) */
export function getEnv(): Env {
  if (_validated) return _validated;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`[env] Missing or invalid environment variables:\n${missing}`);
    throw new Error(`Environment validation failed:\n${missing}`);
  }

  _validated = result.data;
  return _validated;
}
