"use client";

import { useState } from "react";
import { CallPanel } from "./call-panel";
import { Dashboard } from "./dashboard";

export function Demo() {
  const [callActive, setCallActive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <section className="mx-auto grid max-w-6xl gap-6 px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <CallPanel
        onActiveChange={(active) => {
          setCallActive(active);
          // The end-of-call report arrives a few seconds after hang-up; refresh twice to catch it.
          if (!active) {
            setTimeout(() => setRefreshKey((k) => k + 1), 3000);
            setTimeout(() => setRefreshKey((k) => k + 1), 9000);
          }
        }}
        onToolResult={() => setRefreshKey((k) => k + 1)}
      />
      <Dashboard fast={callActive} refreshKey={refreshKey} />
    </section>
  );
}
