import { useEffect, useState, type ReactNode } from "react";

const exitDuration = 180;

export function usePresence(open: boolean) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const timer = window.setTimeout(() => setMounted(false), exitDuration);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  return mounted;
}

export function MotionPanel({ open, children }: { open: boolean; children: ReactNode }) {
  const mounted = usePresence(open);
  if (!mounted) return null;

  return (
    <div className={`motion-panel ${open ? "is-open" : ""}`} inert={!open} aria-hidden={!open}>
      <div className="motion-panel-inner">{children}</div>
    </div>
  );
}
