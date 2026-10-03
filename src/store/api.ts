import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { Evidence, Lease, Objection, PendingOp, SessionPhase, SessionState, TimelineEntry } from "../types";

const KEY = "pair-wise-yf-49/court";

export interface PersistedState {
  deviceId: string;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  lease: Lease | null;
  leaseHistory: Lease[];
  pendingOps: PendingOp[];
}

export const courtApi = createApi({
  reducerPath: "courtApi",
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getState: builder.query<PersistedState | null, void>({
      queryFn: async () => {
        const raw = localStorage.getItem(KEY);
        return { data: raw ? (JSON.parse(raw) as PersistedState) : null };
      }
    }),
    saveState: builder.mutation<{ ok: true }, PersistedState>({
      queryFn: async (payload) => {
        localStorage.setItem(KEY, JSON.stringify(payload));
        return { data: { ok: true } };
      }
    })
  })
});

export const { useGetStateQuery, useSaveStateMutation } = courtApi;
