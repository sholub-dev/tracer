/// <reference types="vite/client" />

/** True in the iOS app build (`vite build --mode ios`). */
export const IS_IOS = import.meta.env.MODE === "ios";
