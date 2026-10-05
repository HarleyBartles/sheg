export type SchemaVersionStep = { fromVersion: number; toVersion: number };

export function hasSequentialMigrationPath(fromVersion: number, targetVersion: number, migrations: readonly SchemaVersionStep[]): boolean {
  let version = fromVersion;
  while (version < targetVersion) {
    const migration = migrations.find(({ fromVersion: candidate }) => candidate === version);
    if (!migration || migration.toVersion !== version + 1 || migration.toVersion > targetVersion) return false;
    version = migration.toVersion;
  }
  return version === targetVersion;
}
