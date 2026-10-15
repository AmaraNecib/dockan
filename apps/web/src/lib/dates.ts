/**
 * Deterministic day-first date/time formatting for the web UI (issue #119).
 *
 * The api stores naive Algeria-local strings with no timezone:
 * `YYYY-MM-DD` for dates and `YYYY-MM-DDTHH:mm:ss` for moments
 * (`localDate` / `localDateTime` in the api logger). The owner's build is
 * Windows in Algeria, so `Intl.DateTimeFormat` / `toLocale*` renders
 * `10/01/2026 01:18 AM` — month-first with a 12-hour clock. Every display
 * string here is pure string work: no `Date` parsing, no locale, no device
 * timezone. The same row renders identically on any machine.
 *
 * Display shape: `DD/MM/YYYY` and `DD/MM/YYYY HH:mm`, 24-hour, Western digits.
 * Seconds are trimmed from display; they are never useful to the owner.
 *
 * Invalid input is returned unchanged. A display formatter must never blank a
 * row or print "Invalid Date" over a legacy value — a wrong-but-visible string
 * is something the owner can report, a crash or a blank cell is not. Invalid
 * includes impossible calendar dates (`2026-02-31`) and out-of-range clock
 * fields (`24:00`, `00:99`): the stored shape is fixed-width, not a date.
 */

/** Stored shape: `YYYY-MM-DD`, optionally `T`/space + `HH:mm` with optional `:ss`. */
const STORED_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Typed shape: `D/M/YYYY`, optionally whitespace + `H:mm` with optional `:ss`. */
const TYPED_DATE_TIME = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface StoredMoment {
  year: string;
  month: string;
  day: string;
  /** absent for a date-only stored value */
  hour: string | null;
  minute: string | null;
}

/** Range-check a numeric field; an absent field cannot be out of range. */
function inRange(value: string | undefined | null, min: number, max: number): boolean {
  if (value === undefined || value === null) return true;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

/** Whether `Y-M-D` is a real calendar day (leap years included). */
function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= (leap ? 29 : 28);
  }
  return day <= (DAYS_IN_MONTH[month - 1] ?? 0);
}

/** Strict parse of the stored shape; `null` for anything else. */
function parseStored(iso: string): StoredMoment | null {
  const match = STORED_DATE_TIME.exec(iso);
  if (match === null) return null;
  const year = match[1];
  const month = match[2];
  const day = match[3];
  if (year === undefined || month === undefined || day === undefined) return null;
  const hour = match[4] ?? null;
  const minute = match[5] ?? null;
  const second = match[6] ?? null;
  // a date with a time is a moment; a date alone is not given a fabricated 00:00
  if ((hour === null) !== (minute === null)) return null;
  if (!isRealDate(Number(year), Number(month), Number(day))) return null;
  if (!inRange(hour, 0, 23) || !inRange(minute, 0, 59) || !inRange(second, 0, 59)) return null;
  return { year, month, day, hour, minute };
}

/** Zero-pad a date/time field for the api's fixed-width shape. */
function pad2(value: string): string {
  return value.padStart(2, "0");
}

/** The day-first calendar day of an already-parsed stored value. */
function formatStoredDay(parsed: StoredMoment): string {
  return `${parsed.day}/${parsed.month}/${parsed.year}`;
}

/**
 * Display a stored date or moment day-first: `2026-10-01` → `01/10/2026`.
 * A moment keeps only its calendar day. An unparseable value is returned as-is.
 */
export function formatDate(iso: string): string {
  const parsed = parseStored(iso);
  if (parsed === null) return iso;
  return formatStoredDay(parsed);
}

/**
 * Display a stored moment as `01/10/2026 00:34` — day-first, 24-hour, seconds
 * trimmed. A date-only value renders as the day alone rather than inventing
 * a midnight the record does not carry. Unparseable input is returned as-is.
 *
 * In an RTL cell the two number runs lay out date-right / time-left (UAX#9:
 * `/` and `:` stay inside each number run), which is the owner's reading order.
 * Do not wrap the output in an LTR node — that flips both the run order and
 * `text-align: start`.
 */
export function formatDateTime(iso: string): string {
  const parsed = parseStored(iso);
  if (parsed === null) return iso;
  const date = formatStoredDay(parsed);
  if (parsed.hour === null || parsed.minute === null) return date;
  return `${date} ${parsed.hour}:${parsed.minute}`;
}

/**
 * A business date with the clock time of the moment the row was recorded:
 * `2026-10-01` + `2026-10-02T14:32:00` → `2026-10-01T14:32:00`. The business
 * date stays authoritative for the day (a backdated invoice keeps its own
 * date); the moment only supplies the time. Feed the result to `formatDateTime`.
 */
export function combineBusinessDateTime(businessDate: string, recordedAt: string): string {
  const time = recordedAt.slice(11);
  return time === "" ? businessDate : `${businessDate}T${time}`;
}

/**
 * Parse the text the editable date/time field teaches: `D/M/YYYY` with an
 * optional `H:mm` (and optional `:ss`). Whitespace is trimmed and runs of
 * whitespace between the date and the time are accepted; a bare date means
 * midnight. Returns the api's naive ISO moment (`YYYY-MM-DDTHH:mm:ss`), or
 * `null` when the text is not a real day-first date/time — including an
 * impossible calendar day (`31/02/2026`) and the raw stored shape, so a pasted
 * ISO value is corrected instead of accepted.
 */
export function parseDateTimeText(text: string): string | null {
  const match = TYPED_DATE_TIME.exec(text.trim());
  if (match === null) return null;
  const day = match[1];
  const month = match[2];
  const year = match[3];
  if (day === undefined || month === undefined || year === undefined) return null;
  const hour = match[4] ?? "0";
  const minute = match[5] ?? "0";
  const second = match[6] ?? "0";
  if (!isRealDate(Number(year), Number(month), Number(day))) return null;
  if (!inRange(hour, 0, 23) || !inRange(minute, 0, 59) || !inRange(second, 0, 59)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

/**
 * The app's text for the current device-local moment — the «الآن» button's
 * value. The shop PC is in Algeria, so device-local is Algeria-local, which is
 * the convention every stored timestamp uses.
 */
export function nowDateTimeText(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const moment = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return formatDateTime(moment);
}

/**
 * A range bound's live text and the api moment it currently applies. Keeping
 * the two together is what stops a half-typed value from reaching the query:
 * the bound only moves when the text is empty or a real, readable moment.
 */
export interface DateBound {
  text: string;
  /** the api's naive ISO moment; `undefined` is an open bound */
  bound: string | undefined;
}

/** An untouched range bound: no text, no filter. Frozen so the two bounds that
 * share it as a `useState` initial value can never drift. */
export const OPEN_BOUND: DateBound = Object.freeze({ text: "", bound: undefined });

/**
 * Fold an edit into a range bound (issue #123). Empty text opens the bound; a
 * readable moment replaces it; anything else (a half-typed or impossible value)
 * keeps the previous bound. That is deliberate: if unreadable text dropped the
 * bound, editing an existing range would refetch the whole list unfiltered on
 * every keystroke — a widening `datetime-local` never produced. The field's
 * visible refusal, not a silent widening, tells the owner the value was not
 * applied.
 */
export function editDateBound(previous: DateBound, text: string): DateBound {
  if (text.trim() === "") return { text, bound: undefined };
  const parsed = parseDateTimeText(text);
  return parsed === null ? { text, bound: previous.bound } : { text, bound: parsed };
}
