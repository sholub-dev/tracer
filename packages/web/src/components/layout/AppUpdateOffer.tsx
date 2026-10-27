import { useEffect, useRef } from "react";
import { App } from "@capacitor/app";
import { toast } from "sonner";
import { fetchLatestAppVersion, shouldCheckForAppUpdate, shouldOfferAppUpdate } from "@/lib/app-update";
import { WEB_CONFIG } from "@/lib/config";
import { useOnResume } from "@/lib/resume";

// Memory only: "Later" lasts until the next cold launch.
let dismissedVersion: string | null = null;

/** iOS only: offers the TestFlight update when the npm release is newer than this build, on launch and on each return to the app. */
export function AppUpdateOffer() {
  const lastCheckAt = useRef<number | null>(null);
  const checking = useRef(false);

  const check = async () => {
    if (checking.current || !shouldCheckForAppUpdate(lastCheckAt.current, Date.now(), WEB_CONFIG.appUpdateCheckMinIntervalMs)) return;
    checking.current = true;
    try {
      const [installed, latest] = await Promise.all([App.getInfo().then((i) => i.version), fetchLatestAppVersion()]);
      if (!latest) return;
      lastCheckAt.current = Date.now();
      if (!shouldOfferAppUpdate(installed, latest, dismissedVersion)) return;
      toast(`Tracer ${latest} is available`, {
        id: "app-update",
        duration: Infinity,
        action: { label: "Update in TestFlight", onClick: () => window.open("itms-beta://", "_blank") },
        cancel: { label: "Later", onClick: () => {} },
        onDismiss: () => { dismissedVersion = latest; },
      });
    } catch {
      // Offline or no app info: stay silent.
    } finally {
      checking.current = false;
    }
  };

  useEffect(() => { void check(); }, []);
  useOnResume(() => void check());
  return null;
}
