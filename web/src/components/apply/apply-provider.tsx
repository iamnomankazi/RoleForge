"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Compatibility-only context for callers that still import the old Apply
 * components. Phase 1A deliberately exposes no client execution path: every
 * action is a no-op and the state is permanently error/disabled.
 */
export type FillStep = { fieldId: string; label: string; ok: boolean; thumb?: string };
// Keep the historical status vocabulary so compatibility consumers typecheck,
// while the provider below can only ever expose the terminal "error" state.
type Status = "idle" | "opening" | "driving" | "prefilling" | "ready" | "filling" | "done" | "error";

type ApplyCtx = {
  status: Status;
  url: string;
  title: string;
  company: string;
  fields: never[];
  answers: Record<string, string>;
  meta: Record<string, { needsConfirmation?: boolean }>;
  steps: FillStep[];
  shots: string[];
  prefillLog: string[];
  issues: never[];
  driveSteps: never[];
  error: string;
  open: (url: string, opts?: { prefill?: boolean; company?: string }) => Promise<void>;
  prefill: () => Promise<void>;
  setAnswer: (idOrLabel: string, value: string) => void;
  fill: () => Promise<void>;
  agentFill: () => Promise<void>;
  reset: () => void;
};

const DISABLED_ERROR = "Web Apply is disabled; use the private root application engine.";
const Ctx = createContext<ApplyCtx | null>(null);

export function useApply(): ApplyCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApply must be used within <ApplyProvider>");
  return c;
}

export function ApplyProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ApplyCtx>(
    () => ({
      status: "error",
      url: "",
      title: "",
      company: "",
      fields: [],
      answers: {},
      meta: {},
      steps: [],
      shots: [],
      prefillLog: [],
      issues: [],
      driveSteps: [],
      error: DISABLED_ERROR,
      open: async () => {},
      prefill: async () => {},
      setAnswer: () => {},
      fill: async () => {},
      agentFill: async () => {},
      reset: () => {},
    }),
    [],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
