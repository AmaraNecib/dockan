import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * #337 — one identity rule for a party's typed name.
 *
 * SQLite's one-argument `TRIM(X)` strips U+0020 only, while the wire contract
 * and every `.trim()` in the app strip the ECMAScript `WhiteSpace` +
 * `LineTerminator` set. A stored name padded with anything outside the plain
 * space therefore read as a SECOND party on the debts screen and could not be
 * asked for by that party's drill-down.
 *
 * `TRIM_CHARS` is exactly the set `String.prototype.trim()` removes. It is
 * listed rather than derived because SQL needs the characters themselves, and
 * `trim-chars.test.ts` compares the two sets exhaustively, so neither side can
 * drift from the other without a red test.
 */
export const TRIM_CHARS = "\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/**
 * `TRIM(target, TRIM_CHARS)` as a drizzle expression: the ONE trimming rule,
 * shared by the group key, the returned summary label and the drill-down's
 * WHERE, so the read that groups a party and the read that opens it cannot
 * disagree about who that party is.
 *
 * `target` is the stored column, or the typed name being asked for — drizzle
 * binds a plain value as a parameter, and SQLite applies the same character set
 * to both sides, which is what makes them the same identity. It stays a read
 * rule: rows already stored keep their padding (a normalize-on-write would
 * rewrite history and miss every row written before it).
 */
export function trimSql(target: SQLWrapper | string | null): SQL {
  return sql`TRIM(${target}, ${TRIM_CHARS})`;
}
