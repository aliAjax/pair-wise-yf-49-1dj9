import { configureStore } from "@reduxjs/toolkit";
import { courtApi } from "./api";
import courtReducer from "./courtSlice";
export const store = configureStore({ reducer: { court: courtReducer, [courtApi.reducerPath]: courtApi.reducer }, middleware: (getDefault) => getDefault().concat(courtApi.middleware) });
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
