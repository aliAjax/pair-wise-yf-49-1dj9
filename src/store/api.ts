import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { CourtDoc } from "./courtSlice";

const KEY = "pair-wise-yf-49/court";

interface StoredShape extends Partial<CourtDoc> {
  /** 旧版仅保存证据数组时的字段 */
  evidence?: CourtDoc["evidence"];
}

export const courtApi = createApi({
  reducerPath: "courtApi",
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getCourtDoc: builder.query<StoredShape | null, void>({
      queryFn: async () => {
        const raw = localStorage.getItem(KEY);
        return { data: raw ? (JSON.parse(raw) as StoredShape) : null };
      }
    }),
    saveCourtDoc: builder.mutation<{ ok: true }, CourtDoc>({
      queryFn: async (doc) => {
        localStorage.setItem(KEY, JSON.stringify(doc));
        return { data: { ok: true } };
      }
    })
  })
});

export const { useGetCourtDocQuery, useSaveCourtDocMutation } = courtApi;
