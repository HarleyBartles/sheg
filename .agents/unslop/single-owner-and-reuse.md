# Single rule owner and operation-local reuse

Keep each domain vocabulary, normalization rule, and persisted-shape contract owned once. Decode untrusted stored values at the storage boundary into declared domain values. Reuse values and outcomes already obtained within an operation; use focused, bounded reads when more data is needed. Keep provider I/O outside synchronous transactions and preserve snapshot and rollback guarantees.

Apply this guard when changing domain schemas, storage codecs, read or command repositories, workers, reports, or material and journey rules. Share a rule only when its semantics are actually identical. Keep separate report contracts separate, and retain compatibility types or vendored upstream code that still serves a supported path.

Observed during dev.16 in commits `0bc5630b180f5f53a8630f83a777fbc9eb40c12a`, `c712ac65c64de92ef18123b4374e91344344d529`, `778a6753ce07de1bca57fe5a8ba7de55f8a12ec2`, and `1ba492aed4fccaca9438a54cd90fec74fe8fd7fe`. These references identify corrected cases; discoverability and effectiveness remain to be assessed in later work.
