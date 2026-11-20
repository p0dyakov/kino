"use client";

import { useEffect, type ReactNode } from "react";
import { FluidProvider } from "@/lib/fluid-provider";
import { Agentation } from "agentation";
import { Nav } from "@/components/nav";

function DevGrab() {
  useEffect(() => {
    let cancelled = false;
    import("react-grab").then(({ init }) => {
      if (cancelled) return;
      const api = init();
      api.setOptions({
        activationKey: (e) => e.altKey && e.code === "KeyC",
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <FluidProvider shape="rounded" size="default">
      <Nav />
      {children}
      {process.env.NODE_ENV === "development" && (
        <>
          <DevGrab />
          <Agentation />
        </>
      )}
    </FluidProvider>
  );
}
