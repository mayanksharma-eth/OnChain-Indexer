/** Raised when a decoded event can't be applied to current domain state: the referenced intent
 * doesn't exist yet (events applied out of causal order), or the transition it implies is
 * invalid for the intent's current status (e.g. filling an already-cancelled intent). Distinct
 * from a plain Error so callers can choose to log-and-skip instead of crashing the indexer. */
export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}
