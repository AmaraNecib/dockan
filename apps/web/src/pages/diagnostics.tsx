import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";

import { orpc } from "../lib/rpc";
import { logEventCopy, logMessageCopy } from "../lib/log-copy";

/**
 * One parsed JSONL row. The api owns the shape (LogEntry in
 * apps/api/src/lib/logger.ts); the viewer parses it at the I/O boundary with
 * zod and shows raw text for any malformed line instead of crashing.
 */
const logRowSchema = z.object({
  ts: z.string(),
  level: z.enum(["info", "warn", "error"]).default("info"),
  event: z.string(),
  message: z.string().default(""),
  code: z.string().optional(),
  stack: z.string().optional(),
  errorName: z.string().optional(),
});

type LogRow = z.infer<typeof logRowSchema>;

function parseRow(line: string): LogRow | null {
  try {
    // zod is the contract check: JSON cannot be trusted at the file boundary
    const parsed = logRowSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // not even JSON — the caller renders the raw line
  }
}

const levelStyle = {
  info: "bg-muted text-muted-foreground",
  warn: "bg-warning/10 text-warning",
  error: "bg-destructive/10 text-destructive",
} as const;

function LogRowCard({ row, raw }: { row: LogRow | null; raw?: string }) {
  const { t } = useTranslation();
  if (row === null) {
    // malformed line — show it as-is so nothing is silently dropped
    return (
      <pre dir="ltr" className="overflow-x-auto rounded border bg-card p-3 font-mono text-xs text-muted-foreground">
        {raw}
      </pre>
    );
  }
  return (
    <article className="rounded border bg-card p-3" data-testid="diagnostics-row">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <time className="font-mono text-xs text-muted-foreground" dir="ltr">
          {row.ts}
        </time>
        <span className={`rounded px-1.5 py-0.5 text-xs ${levelStyle[row.level]}`}>{row.level}</span>
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
          data-testid="diagnostics-event"
          data-event={row.event}
          title={row.event}
        >
          {logEventCopy(t, row.event)}
        </span>
        {row.code && (
          <span className="rounded bg-primary px-1.5 py-0.5 font-mono text-xs text-primary-foreground" dir="ltr" data-testid="diagnostics-code">
            {row.code}
          </span>
        )}
        {row.errorName && (
          <span className="font-mono text-xs text-muted-foreground/60" dir="ltr">
            {row.errorName}
          </span>
        )}
      </header>
      <p className="mt-1.5 text-sm text-foreground">{logMessageCopy(t, row.event, row.message)}</p>
      {row.stack && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">{t("diagnosticsStack")}</summary>
          <pre dir="ltr" className="mt-1.5 overflow-x-auto rounded bg-accent p-2 font-mono text-xs text-muted-foreground">
            {row.stack}
          </pre>
        </details>
      )}
    </article>
  );
}

/**
 * Ticket 14 — diagnostics log viewer (developer-facing). Admin-session
 * guarded like every page (RequireSession wraps the router); shows today's
 * tail of the daily JSONL log, newest first. The api reads the file; this
 * page only parses and renders.
 */
export function DiagnosticsPage() {
  const { t } = useTranslation();
  const logs = useQuery(orpc.diagnosticsLogsTail.queryOptions({ input: { lines: 200 } }));

  return (
    <section>
      <h1 className="text-xl font-bold" data-testid="diagnostics-title">
        {t("diagnosticsTitle")}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("diagnosticsHint")}</p>
      {logs.data && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="diagnostics-file">
          {t("diagnosticsFile")} <span dir="ltr" className="font-mono">{logs.data.file}</span>
        </p>
      )}

      {logs.isError ? (
        <div className="mt-4 flex items-center justify-between rounded border bg-destructive/10 p-3 text-sm text-destructive">
          <span>{t("activityError")}</span>
          <button type="button" className="underline" onClick={() => void logs.refetch()}>
            {t("itemsSearchRetry")}
          </button>
        </div>
      ) : logs.isPending || !logs.data ? (
        <div className="mt-4 grid gap-3 rounded border bg-card p-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-14 w-full" />
          ))}
        </div>
      ) : logs.data.lines.length === 0 ? (
        <EmptyState
          testId="diagnostics-empty"
          card
          className="mt-4"
          title={t("diagnosticsEmpty")}
          hint={t("diagnosticsEmptyHint")}
        />
      ) : (
        <div className="mt-4 grid gap-2" data-testid="diagnostics-list">
          {/* the api tail is newest-last (chronological); the viewer shows newest first.
              Keys come from the RAW (unreversed) index so an appended line — the only
              change a refetch can make — never remounts every existing row. */}
          {[...logs.data.lines]
            .map((line, rawIndex) => ({ line, rawIndex }))
            .reverse()
            .map(({ line, rawIndex }) => {
              const row = parseRow(line);
              // SAFETY: parseRow collapses malformed lines to null; the raw line
              // + raw index key keeps React identity stable across refetches
              return <LogRowCard key={`${line}-${rawIndex}`} row={row} raw={line} />;
            })}
        </div>
      )}
    </section>
  );
}