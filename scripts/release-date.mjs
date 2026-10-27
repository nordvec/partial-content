/**
 * The one strict `YYYY-MM-DD` parser the release scripts share.
 *
 * `Date.parse` rolls a day the month does not have into the next month
 * (`2026-02-30` becomes March 2), so a shape check plus `Date.parse` accepts a
 * date no calendar contains. A date is real only when the instant it parses to
 * prints back as the same text.
 */

const SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The ISO instant at UTC midnight for a calendar date, or undefined when the
 * text is not a real `YYYY-MM-DD` date.
 * @param {string} date
 * @returns {string | undefined}
 */
export function releaseInstantOf(date) {
    if (!SHAPE.test(date)) return undefined;
    const instant = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) return undefined;
    return `${date}T00:00:00Z`;
}
