// The Host service error type. Kept free of Host authority state so small Host-owned helpers (source provenance) can
// be imported without loading the authority, its Store or SQLite.
export class HostError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
