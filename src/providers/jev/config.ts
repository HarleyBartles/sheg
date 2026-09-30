import { z } from 'zod';

export const jevRouteSchema = z.enum(['openrouter', 'typesafe']);
export type JevRoute = z.infer<typeof jevRouteSchema>;

const routeDefaults = {
  openrouter: {
    model: 'typesafe/jev-1.13',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
  },
  typesafe: {
    model: 'jev-latest',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
  },
} satisfies Record<JevRoute, { model: string; endpoint: string }>;

export const jevConfigInputSchema = z.object({
  kind: z.literal('jev'),
  route: jevRouteSchema.optional(),
  model: z.string().min(1).optional(),
  endpoint: z.string().url().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict().superRefine((input, context) => {
  if (input.endpoint === undefined) return;
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch { return; }
  const expectedOrigin = new URL(routeDefaults[input.route ?? 'openrouter'].endpoint).origin;
  if (endpoint.origin !== expectedOrigin || endpoint.username || endpoint.password) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Jev endpoint must use the selected provider HTTPS origin without URL credentials.' });
  }
});

export const jevConfigSchema = jevConfigInputSchema.transform((input) => {
  const route = input.route ?? 'openrouter';
  const defaults = routeDefaults[route];
  return {
    kind: 'jev' as const,
    route,
    model: input.model ?? defaults.model,
    endpoint: input.endpoint ?? defaults.endpoint,
    timeoutMs: input.timeoutMs ?? 30_000,
  };
});

export type JevConfigInput = z.input<typeof jevConfigSchema>;
export type JevConfig = z.output<typeof jevConfigSchema>;

export function defaultJevConfig(route: JevRoute = 'openrouter'): JevConfig {
  return jevConfigSchema.parse({ kind: 'jev', route });
}
