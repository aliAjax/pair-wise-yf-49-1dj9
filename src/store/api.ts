import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { Evidence } from "../types";
const KEY = "pair-wise-yf-49/court";
export const courtApi = createApi({
  reducerPath: "courtApi",
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getEvidence: builder.query<Evidence[], void>({ queryFn: async () => { const raw = localStorage.getItem(KEY); return { data: raw ? JSON.parse(raw).evidence : [] }; } }),
    saveEvidence: builder.mutation<{ ok: true }, Evidence[]>({ queryFn: async (payload) => { const raw = localStorage.getItem(KEY); const current = raw ? JSON.parse(raw) : {}; localStorage.setItem(KEY, JSON.stringify({ ...current, evidence: payload })); return { data: { ok: true } }; } })
  })
});
export const { useGetEvidenceQuery, useSaveEvidenceMutation } = courtApi;
