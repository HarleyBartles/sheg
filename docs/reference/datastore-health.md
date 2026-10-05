# Datastore health checks

Normal startup checks the schema version, migration identities and checksums, the recorded schema fingerprint, and required table columns. It does not run a full SQLite integrity or foreign-key scan on every open. Persisted JSON is validated when a repository reads the corresponding evidence.

Run the storage inspection operation to request full SQLite integrity and foreign-key checks. Migrations and verified backups also run those checks before and after schema changes. A failed health check reports the datastore as unhealthy; Sheg does not silently repair or reset it.

An older pre-release schema or unknown future schema remains available through the maintenance surface for explicit inspection and recovery. Reset preserves a verified database backup when SQLite can read the source, or quarantines the original database and sidecars when it cannot.
