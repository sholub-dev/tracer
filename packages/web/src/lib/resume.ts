import { useEffect, useRef } from "react";

/** Fired when the iOS app returns to the foreground; open views re-check their session. */
export const RESUME_EVENT = "tracer:resume";

export function useOnResume(callback: () => void) {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener(RESUME_EVENT, handler);
    return () => window.removeEventListener(RESUME_EVENT, handler);
  }, []);
}
