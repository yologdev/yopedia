"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { extractCitedSlugs } from "@/lib/citations";
import {
  STREAM_DONE_SENTINEL,
  STREAM_ERROR_SENTINEL,
} from "@/lib/constants";
import type { QueryFormat } from "@/lib/query-format";

export interface QueryResponse {
  answer: string;
  sources: string[];
  error?: string;
}

export interface UseStreamingQueryReturn {
  question: string;
  setQuestion: (q: string) => void;
  format: QueryFormat;
  setFormat: (f: QueryFormat) => void;
  /** Active scope sent with each query ("mine", "owner:<h>", or undefined=All). */
  scope: string | undefined;
  setScope: (s: string | undefined) => void;
  result: QueryResponse | null;
  setResult: (r: QueryResponse | null) => void;
  loading: boolean;
  setLoading: (l: boolean) => void;
  streaming: boolean;
  setStreaming: (s: boolean) => void;
  error: string | null;
  setError: (e: string | null) => void;
  submit: (e: React.FormEvent) => void;
  /**
   * Run a query programmatically (e.g. from a `?q=` deep link). `scopeOverride`
   * applies that scope to THIS run directly — pass it when the scope arrives in
   * the same tick (deep link) and `scope` state may not have propagated yet.
   */
  runQuery: (q: string, scopeOverride?: string) => void;
  isProcessing: boolean;
}

interface UseStreamingQueryOptions {
  onComplete?: (
    question: string,
    answer: string,
    sources: string[],
    format: QueryFormat,
  ) => void;
  onSubmitStart?: () => void;
  /** Initial query scope (e.g. "mine" when signed in, or a deep-linked owner:<h>). */
  initialScope?: string;
}

export function useStreamingQuery(
  options: UseStreamingQueryOptions = {},
): UseStreamingQueryReturn {
  const [question, setQuestion] = useState("");
  const [format, setFormat] = useState<QueryFormat>("prose");
  const [scope, setScope] = useState<string | undefined>(options.initialScope);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Stable ref for callbacks so we don't trigger re-renders
  const onCompleteRef = useRef(options.onComplete);
  onCompleteRef.current = options.onComplete;
  const onSubmitStartRef = useRef(options.onSubmitStart);
  onSubmitStartRef.current = options.onSubmitStart;

  // Abort any in-flight streaming request on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Core query runner — takes the question explicitly so it can be driven both
  // by the form (submit) and programmatically (runQuery), with no state-timing
  // race between setQuestion() and reading `question` back.
  const execute = useCallback(
    async (rawQuestion: string, scopeOverride?: string) => {
      const trimmed = rawQuestion.trim();
      if (!trimmed) return;
      // Use the explicit scope when given (deep-link arriving the same tick that
      // setScope was called, before state propagates); else the current state.
      const effectiveScope = scopeOverride ?? scope;

      // Abort any previous in-flight request
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setLoading(true);
      setStreaming(false);
      setError(null);
      setResult(null);
      onSubmitStartRef.current?.();

      try {
        // Slides/HTML are baked server-side (each illustration generated once →
        // stored in R2), so they're produced COMPLETE by the non-streaming
        // /api/query — the full answer must exist before its image can be baked
        // in, so there's no token streaming for these; the loading spinner
        // covers the wait. Prose/table (no illustrations) stream as usual.
        if (format === "slides" || format === "html") {
          const res = await fetch("/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: trimmed, format, scope: effectiveScope }),
            signal: controller.signal,
          });
          const data = await res.json().catch(() => null);
          if (!res.ok || !data) {
            setError(data?.error ?? `Request failed (${res.status})`);
            return;
          }
          setResult(data);
          onCompleteRef.current?.(trimmed, data.answer, data.sources, format);
          return;
        }

        // Try the streaming endpoint first
        const res = await fetch("/api/query/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed, format, scope: effectiveScope }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Streaming endpoint failed — try non-streaming fallback
          const data = await res.json().catch(() => null);
          const errMsg = data?.error ?? `Request failed (${res.status})`;

          // Fall back to non-streaming endpoint
          const fallbackRes = await fetch("/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: trimmed, format, scope: effectiveScope }),
            signal: controller.signal,
          });

          const fallbackData = await fallbackRes.json().catch(() => null);
          if (!fallbackRes.ok || !fallbackData) {
            setError(fallbackData?.error ?? errMsg);
            return;
          }
          setResult(fallbackData);
          onCompleteRef.current?.(
            trimmed,
            fallbackData.answer,
            fallbackData.sources,
            format,
          );
          return;
        }

        // Parse sources from the custom header. The server percent-encodes the
        // JSON so non-ASCII slugs (e.g. CJK titles) survive the Latin-1 header
        // transport; decode before parsing.
        const sourcesHeader = res.headers.get("X-Wiki-Sources");
        let sources: string[] = [];
        if (sourcesHeader) {
          try {
            sources = JSON.parse(decodeURIComponent(sourcesHeader)) as string[];
          } catch {
            // Malformed header — fall back to empty array
            sources = [];
          }
        }

        // Stream the response body
        const reader = res.body?.getReader();
        if (!reader) {
          setError("Streaming not supported by the browser");
          return;
        }

        setStreaming(true);
        setLoading(false);

        const decoder = new TextDecoder();
        let answer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          answer += chunk;
          setResult({ answer, sources });
        }

        // Check for stream sentinels and strip them from the displayed answer.
        const hasErrorSentinel = answer.includes(STREAM_ERROR_SENTINEL);
        const hasDoneSentinel = answer.includes(STREAM_DONE_SENTINEL);
        const streamTruncated = !hasDoneSentinel && !hasErrorSentinel;

        // Strip sentinel markers from the answer text
        if (hasDoneSentinel) {
          answer = answer.replace(STREAM_DONE_SENTINEL, "");
        }
        if (hasErrorSentinel) {
          answer = answer.replace(STREAM_ERROR_SENTINEL, "");
        }

        // Show a warning if the stream was incomplete
        if (hasErrorSentinel || streamTruncated) {
          const warning = "Answer may be incomplete (connection interrupted)";
          setResult({ answer, sources, error: warning });
          setError(warning);
          setStreaming(false);
          // Still call onComplete so the partial answer is saved if the caller wants it
          onCompleteRef.current?.(trimmed, answer, sources, format);
          return;
        }

        // Refine sources to only those actually cited in the answer
        const citedSources = extractCitedSlugs(answer, sources);
        // Fall back to loaded sources if no citations detected (defensive)
        const finalSources =
          citedSources.length > 0 ? citedSources : sources;
        setResult({ answer, sources: finalSources });
        setStreaming(false);

        // Notify caller that query completed
        onCompleteRef.current?.(trimmed, answer, finalSources, format);
      } catch (err) {
        // Don't report abort errors as failures
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError("Failed to connect to the server");
      } finally {
        setLoading(false);
        setStreaming(false);
      }
    },
    [format, scope],
  );

  // Form submit — reads the current question from state.
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      execute(question);
    },
    [execute, question],
  );

  // Programmatic run — submits with the given question directly (also reflects
  // it in the input via setQuestion).
  const runQuery = useCallback(
    (q: string, scopeOverride?: string) => {
      setQuestion(q);
      if (scopeOverride !== undefined) setScope(scopeOverride);
      execute(q, scopeOverride);
    },
    [execute],
  );

  const isProcessing = loading || streaming;

  return {
    question,
    setQuestion,
    format,
    setFormat,
    scope,
    setScope,
    result,
    setResult,
    loading,
    setLoading,
    streaming,
    setStreaming,
    error,
    setError,
    submit: handleSubmit,
    runQuery,
    isProcessing,
  };
}
