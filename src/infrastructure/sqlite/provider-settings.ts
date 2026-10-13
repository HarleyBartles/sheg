import { RunStoreError } from '../../application/run-store.js';
import { providerCatalogueSchema, providerPreferenceSchema, type ProviderCatalogue, type ProviderPreference } from '../../providers/config.js';
import { asNumber, parseJson } from './rows.js';
import type { SqliteRepositoryContext } from './repository-context.js';

export function readProviderSettings(context: SqliteRepositoryContext): { catalogue: ProviderCatalogue; preferences: ProviderPreference } {
  context.ensureOpen();
  const row = context.database.prepare('SELECT revision, catalogue_json, preferences_json FROM provider_settings WHERE singleton_id = 1').get() as Record<string, unknown> | undefined;
  if (!row) throw new RunStoreError('data_integrity_error', 'Provider settings are missing from the Sheg datastore.');
  const revision = asNumber(row.revision, 'provider settings revision');
  const catalogue = providerCatalogueSchema.safeParse(parseJson(row.catalogue_json, 'provider catalogue'));
  const preferences = providerPreferenceSchema.safeParse(parseJson(row.preferences_json, 'provider preferences'));
  if (!catalogue.success || catalogue.data.revision !== revision || !preferences.success) throw new RunStoreError('data_integrity_error', 'Stored provider settings do not match their schema or revision.');
  return { catalogue: catalogue.data, preferences: preferences.data };
}

export function writeProviderSettings(
  context: SqliteRepositoryContext,
  input: { catalogue: Omit<ProviderCatalogue, 'revision'>; preferences: ProviderPreference },
  expectedRevision: number,
): { catalogue: ProviderCatalogue; preferences: ProviderPreference } {
  context.ensureOpen();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new RunStoreError('invalid_provider_settings_revision', 'Expected provider settings revision must be a nonnegative safe integer.');
  return context.transaction(() => {
    const current = readProviderSettings(context);
    if (current.catalogue.revision !== expectedRevision) throw new RunStoreError('provider_settings_revision_conflict', 'Provider settings changed after they were read. Read the current settings and try again.');
    const catalogue = providerCatalogueSchema.safeParse({ ...input.catalogue, revision: current.catalogue.revision + 1 });
    const preferences = providerPreferenceSchema.safeParse(input.preferences);
    if (!catalogue.success || !preferences.success) throw new RunStoreError('invalid_provider_settings', 'Provider catalogue or preferences do not match the supported contract.');
    const ids = new Set(catalogue.data.entries.map(({ id }) => id));
    if (preferences.data.preferredOrder.some((id) => !ids.has(id))) throw new RunStoreError('invalid_provider_settings', 'Provider preferences must reference identities in the saved catalogue.');
    context.database.prepare('UPDATE provider_settings SET revision = ?, catalogue_json = ?, preferences_json = ? WHERE singleton_id = 1')
      .run(catalogue.data.revision, JSON.stringify(catalogue.data), JSON.stringify(preferences.data));
    return { catalogue: catalogue.data, preferences: preferences.data };
  });
}
