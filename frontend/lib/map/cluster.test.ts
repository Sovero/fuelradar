import { describe, expect, it } from "vitest";
import { clusterLabel } from "@/lib/map/cluster";

describe("clusterLabel", () => {
  it('формирует подпись кластера в формате "N АЗС" (бриф §16.2: «47 АЗС»)', () => {
    expect(clusterLabel(47)).toBe("47 АЗС");
    expect(clusterLabel(1)).toBe("1 АЗС");
  });
});
