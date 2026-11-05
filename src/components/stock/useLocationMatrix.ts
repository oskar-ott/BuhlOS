"use client";

import { useEffect, useState } from "react";
import { fetchLocationMatrix } from "@/domains/workshop-stock/client";
import type { LocationMatrix } from "@/domains/workshop-stock/location-matrix";

/** The racks for the Add form. Null until it answers, or if it can't: the location field still takes typing. */
export function useLocationMatrix(): LocationMatrix | null {
  const [matrix, setMatrix] = useState<LocationMatrix | null>(null);
  useEffect(() => {
    let live = true;
    void fetchLocationMatrix().then((r) => {
      if (live && r.ok && r.data.available) setMatrix(r.data.matrix);
    });
    return () => { live = false; };
  }, []);
  return matrix;
}
