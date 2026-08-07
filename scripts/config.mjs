/** How long an ended campaign stays on the board before it drops out of data.json. */
export const KEEP_ENDED_DAYS = 400;

/** Safety valve: no broker should ever contribute more than this many campaigns. */
export const MAX_PER_BROKER = 60;

/**
 * Candidate links to inspect per broker per run. Each one costs a landing-page
 * read, so this is the main lever on how long a full crawl takes.
 */
export const MAX_CANDIDATES_PER_BROKER = 45;

/**
 * A campaign that stops appearing in any source is assumed to be over. Brokers
 * pull the banner the day a campaign ends and rarely say so, and 元大 leaves old
 * campaign pages online for months, so disappearance is the only signal there is.
 * Two consecutive misses avoids ending a campaign over one flaky crawl.
 */
export const MISSES_BEFORE_ENDED = 2;
